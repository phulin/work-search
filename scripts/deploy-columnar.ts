import {
  readFile,
  writeFile,
  mkdir,
  cp,
  readdir,
  rm,
  appendFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Root, PairRoot } from "../src/columnar/format.js";
import { benchmarkToken } from "../bench/columnar/token.js";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { request as httpsRequest, Agent } from "node:https";
const uploadConcurrency = Number(process.env.CWS_UPLOAD_CONCURRENCY ?? 8);
if (
  !Number.isInteger(uploadConcurrency) ||
  uploadConcurrency < 1 ||
  uploadConcurrency > 16
)
  throw Error("Upload concurrency must be 1..16");
const uploadAgent = new Agent({
  keepAlive: true,
  maxSockets: uploadConcurrency,
});
const compress = promisify(gzip);
function headObjectOnce(address: string, token: string) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
  }>((ok, no) => {
    const r = httpsRequest(
      address,
      {
        method: "HEAD",
        agent: uploadAgent,
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          ok({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    r.setTimeout(120000, () => r.destroy(Error("Upload HEAD timeout")));
    r.once("error", no);
    r.end();
  });
}
async function headObject(address: string, token: string) {
  for (let attempt = 0; ; attempt++)
    try {
      return await headObjectOnce(address, token);
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
}
function uploadObject(
  address: string,
  headers: Record<string, string>,
  body: Buffer,
) {
  // Node 26 fetch negotiates HTTP/2. Long concurrent immutable transfers hit
  // transient stream resets; use the same bounded HTTP/1 agent as HEAD checks.
  return new Promise<{ status: number; text: string }>((ok, no) => {
    const r = httpsRequest(
      address,
      { method: "PUT", agent: uploadAgent, headers },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          if (text.length < 2000) text += chunk.toString();
        });
        response.once("error", no);
        response.once("end", () =>
          ok({ status: response.statusCode ?? 0, text }),
        );
      },
    );
    r.setTimeout(180000, () => r.destroy(Error("Immutable upload timeout")));
    r.once("error", no);
    r.end(body);
  });
}
const [out, name] = process.argv.slice(2);
if (!out || !/^[a-z0-9-]{1,48}$/.test(name ?? ""))
  throw Error(
    "Usage: yarn node --import tsx scripts/deploy-columnar.ts INDEX_DIR BENCHMARK_WORKER",
  );
if (!name.startsWith("work-search-cws-"))
  throw Error("Benchmark Worker name must begin work-search-cws-");
const root: Root = JSON.parse(await readFile(out + "/root.json", "utf8")),
  token = await benchmarkToken();
const pairs: PairRoot | undefined = await readFile(
  out + "/pairs-root.json",
  "utf8",
).then(JSON.parse, () => undefined);
const heads = await readFile(out + "/heads-root.json", "utf8").then(
  JSON.parse,
  () => undefined,
);
if (heads && heads.baseGeneration !== root.generation)
  throw Error("Head generation mismatch");
if (pairs && pairs.baseGeneration !== root.generation)
  throw Error("Pair generation mismatch");
await mkdir("work/columnar-deploy", { recursive: true });
const sourceDir = resolve(`work/columnar-deploy/${name}-source`);
for (const dir of ["columnar", "query", "format", "storage"])
  await cp(`src/${dir}`, `${sourceDir}/src/${dir}`, { recursive: true });
await writeFile(sourceDir + "/root.json", JSON.stringify(root));
if (root.directory) {
  const data = await readFile(out + "/directory.bin");
  if (
    data.length !== root.directory.bytes ||
    createHash("sha256").update(data).digest("hex") !== root.directory.sha256
  )
    throw Error("Bundled directory identity mismatch");
  await writeFile(sourceDir + "/directory.bin", data);
}
if (root.documentPackages?.locators) {
  const data = await readFile(out + "/documents.bin"),
    d = root.documentPackages.locators;
  if (
    data.length !== d.bytes ||
    createHash("sha256").update(data).digest("hex") !== d.sha256
  )
    throw Error("Bundled document directory identity mismatch");
  await writeFile(sourceDir + "/documents.bin", data);
}
if (pairs)
  await writeFile(sourceDir + "/pairs-root.json", JSON.stringify(pairs));
if (heads) {
  await cp(out + "/heads.bin", sourceDir + "/heads.bin");
  await writeFile(sourceDir + "/heads-root.json", JSON.stringify(heads));
}
const uploaderConfig = resolve("work/columnar-deploy/upload.json");
if (!process.argv.includes("--deploy-only")) {
  await writeFile(
    uploaderConfig,
    JSON.stringify(
      {
        name: "work-search-cws-upload",
        main: resolve("src/columnar/upload-worker.ts"),
        compatibility_date: "2026-11-01",
        account_id: "8f088d4bd190caf693cc42bb8311fd7d",
        workers_dev: true,
        r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
        limits: { cpu_ms: 300000 },
      },
      null,
      2,
    ),
  );
  await wrangler(["deploy", "--config", uploaderConfig]);
  await wrangler(
    ["secret", "put", "UPLOAD_TOKEN", "--config", uploaderConfig],
    token,
  );
}
const url = "https://work-search-cws-upload.phulin.workers.dev";
if (process.argv.includes("--deploy-only")) {
  const groups = [
    [root.generation, root.objects],
    ...(pairs ? [[pairs.generation, pairs.objects] as const] : []),
  ] as const;
  const pending = groups.flatMap(([generation, objects]) =>
    objects.map((object) => ({ generation, object })),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: uploadConcurrency }, async () => {
      for (;;) {
        const item = pending[next++];
        if (!item) return;
        const { generation, object } = item;
        const h = await headObject(
          `${url}/${object.key ?? `${generation}/${object.name}`}`,
          token,
        );
        if (
          h.status !== 200 ||
          Number(h.headers["content-length"]) !== object.size ||
          h.headers["x-sha256"] !== object.sha256 ||
          (!object.checksums && !h.headers["x-page-crc32"])
        )
          throw Error("Unpublished immutable object " + object.name);
      }
    }),
  );
  uploadAgent.destroy();
}
if (!process.argv.includes("--deploy-only")) {
  const objects = [
    ...root.objects.map((object) => ({
      object,
      generation: root.generation,
      path: out + "/packs/" + object.name,
    })),
    ...(pairs?.objects ?? []).map((object) => ({
      object,
      generation: pairs!.generation,
      path: out + "/pairs/packs/" + object.name,
    })),
  ];
  let next = 0;
  await Promise.all(
    Array.from({ length: uploadConcurrency }, async () => {
      for (;;) {
        const entry = objects[next++];
        if (!entry) break;
        const { object, path, generation } = entry;
        for (let attempt = 0; ; attempt++) {
          try {
            const address = `${url}/${object.key ?? `${generation}/${object.name}`}`,
              head = await headObject(address, token);
            if (head.status === 200) {
              if (
                Number(head.headers["content-length"]) !== object.size ||
                head.headers["x-sha256"] !== object.sha256 ||
                (!object.checksums && !head.headers["x-page-crc32"])
              )
                throw Error("Immutable upload mismatch");
              break;
            }
            if (head.status !== 404) throw Error("Upload HEAD " + head.status);
            const hash = createHash("sha256");
            for await (const data of createReadStream(path)) hash.update(data);
            if (hash.digest("hex") !== object.sha256)
              throw Error("Immutable object mismatch");
            const compressed = await compress(await readFile(path), {
              level: 1,
            });
            const r = await uploadObject(
              address,
              {
                authorization: `Bearer ${token}`,
                "content-length": String(compressed.length),
                "x-sha256": object.sha256,
                "x-raw-length": String(object.size),
                ...(object.checksums
                  ? {
                      "x-page-crc32": Buffer.from(
                        Uint32Array.from(object.checksums).buffer,
                      ).toString("base64"),
                    }
                  : {}),
              },
              compressed,
            );
            if (r.status < 200 || r.status >= 300)
              throw Error("Upload " + r.status + ": " + r.text);
            break;
          } catch (e) {
            if (attempt === 4) throw e;
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          }
        }
        if (process.env.CWS_RECLAIM_LOCAL === "1") {
          const verified = await headObject(
            `${url}/${object.key ?? `${generation}/${object.name}`}`,
            token,
          );
          if (
            verified.status !== 200 ||
            Number(verified.headers["content-length"]) !== object.size ||
            verified.headers["x-sha256"] !== object.sha256 ||
            (!object.checksums && !verified.headers["x-page-crc32"])
          )
            throw Error("Cannot reclaim unverified object " + object.name);
          await appendFile(
            out + "/reclaimed-objects.jsonl",
            JSON.stringify({
              generation,
              name: object.name,
              key: object.key,
              sha256: object.sha256,
              size: object.size,
              at: new Date().toISOString(),
            }) + "\n",
          );
          await rm(path, { force: true });
        }
        console.log(
          "Uploaded",
          object.name,
          object.size,
          new Date().toISOString(),
        );
      }
    }),
  );
  uploadAgent.destroy();
}
if (process.argv.includes("--publish-only")) {
  await writeFile(
    out + "/publication.json",
    JSON.stringify(
      {
        generation: root.generation,
        corpusHash: root.corpusHash,
        objects: root.objects.length,
        completedAt: new Date().toISOString(),
        immutableObjectsVerified: true,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const entry = resolve(`work/columnar-deploy/${name}.ts`),
  config = resolve(`work/columnar-deploy/${name}.json`);
const packetBenchmark = process.argv.includes("--packet-benchmark");
const documentImport = root.documentPackages?.locators
    ? `import documents from ${JSON.stringify(sourceDir + "/documents.bin")};`
    : "",
  documentArgument = root.documentPackages?.locators
    ? "new Uint8Array(documents)"
    : "undefined";
if (packetBenchmark) {
  if (!root.directory || !root.documentPackages)
    throw Error("Packet benchmark requires a complete packet generation");
  await mkdir(sourceDir + "/bench/columnar", { recursive: true });
  await cp(
    "bench/columnar/packet-worker.ts",
    sourceDir + "/bench/columnar/packet-worker.ts",
  );
}
await writeFile(
  entry,
  packetBenchmark
    ? `${documentImport}import root from ${JSON.stringify(sourceDir + "/root.json")};import directory from ${JSON.stringify(sourceDir + "/directory.bin")};import {createPacketBenchmarkWorker} from ${JSON.stringify(sourceDir + "/bench/columnar/packet-worker.ts")};export default createPacketBenchmarkWorker(root as any,new Uint8Array(directory),${documentArgument});`
    : `${documentImport}import root from ${JSON.stringify(sourceDir + "/root.json")};${pairs ? `import pairs from ${JSON.stringify(sourceDir + "/pairs-root.json")};` : ""}${heads ? `import heads from ${JSON.stringify(sourceDir + "/heads-root.json")};import data from ${JSON.stringify(sourceDir + "/heads.bin")};` : ""}${root.directory ? `import directory from ${JSON.stringify(sourceDir + "/directory.bin")};` : ""}import {createColumnarWorker} from ${JSON.stringify(sourceDir + "/src/columnar/worker.ts")};export default createColumnarWorker(root as any,${pairs ? "pairs as any" : "undefined"},${heads ? "{root:heads as any,data:new Uint8Array(data)}" : "undefined"},${root.directory ? "new Uint8Array(directory)" : "undefined"},${documentArgument});`,
);
await writeFile(
  config,
  JSON.stringify(
    {
      name,
      main: entry,
      compatibility_date: "2026-11-01",
      rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      account_id: "8f088d4bd190caf693cc42bb8311fd7d",
      workers_dev: true,
      placement: { region: "aws:us-east-1" },
      r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
      limits: { cpu_ms: 300000 },
      vars: {
        CACHE_NAMESPACE: process.env.CWS_NAMESPACE ?? name,
        PAGE_CACHE: "1",
      },
      observability: { enabled: true },
    },
    null,
    2,
  ),
);
async function wrangler(args: string[], input?: string) {
  await new Promise<void>((ok, no) => {
    const p = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    p.stdin.end(input);
    p.once("error", no);
    p.once("exit", (code) =>
      code === 0 ? ok() : no(Error("Wrangler failed " + code)),
    );
  });
}
await wrangler(["deploy", "--config", config]);
await wrangler(
  ["secret", "put", "INTERNAL_TOKEN", "--config", config],
  await benchmarkToken(),
);
// Deployment acknowledgement can precede workers.dev route propagation.
for (let attempt = 0; ; attempt++) {
  const healthy = await fetch(`https://${name}.phulin.workers.dev/health`)
    .then(
      async (r) =>
        r.ok && ((await r.json()) as any).generation === root.generation,
    )
    .catch(() => false);
  if (healthy) break;
  if (attempt === 29) throw Error("Deployment health did not converge " + name);
  await new Promise((r) => setTimeout(r, 2000));
}
async function hashes(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory())
      for (const [k, v] of Object.entries(await hashes(path)))
        result[entry.name + "/" + k] = v;
    else
      result[entry.name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return result;
}
const sourceFiles = await hashes(sourceDir),
  sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceFiles))
    .digest("hex");
await writeFile(
  `work/columnar-deploy/${name}-manifest.json`,
  JSON.stringify(
    {
      name,
      root: resolve(out + "/root.json"),
      generation: root.generation,
      corpusHash: root.corpusHash,
      deployedAt: new Date().toISOString(),
      namespace: process.env.CWS_NAMESPACE ?? name,
      sourceHash,
      sourceFiles,
      packageSha256: createHash("sha256")
        .update(await readFile("package.json"))
        .digest("hex"),
      lockSha256: createHash("sha256")
        .update(await readFile("yarn.lock"))
        .digest("hex"),
    },
    null,
    2,
  ),
);
