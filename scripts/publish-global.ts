import { PairCostTable } from "../src/global/pair-costs.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { decodePairRoot } from "../src/global/pairs.js";
import { decodeRoot } from "../src/global/format.js";
import { parallel } from "../src/storage/types.js";
const out = process.argv[2] ?? "work/global-index",
  budget = process.env.GLOBAL_BUDGET ?? "8",
  name = process.env.GLOBAL_WORKER ?? "work-search-global",
  bucket = process.env.GLOBAL_BUCKET ?? "work-search-global",
  heads = process.env.GLOBAL_HEADS !== "0",
  binaryPath = resolve(
    out + `/${heads ? "bundle-heads" : "bundle"}-${budget}.bin`,
  ),
  bytes = await readFile(binaryPath),
  { root } = decodeRoot(bytes),
  dir = resolve("work/global-publish/" + name);
const pairDir = process.env.GLOBAL_PAIRS;
const pairBytes = pairDir ? await readFile(pairDir + "/pairs.bin") : undefined;
const pairs = pairBytes ? decodePairRoot(pairBytes, root) : undefined;
const costPath =
  process.env.GLOBAL_PAIR_COSTS === "1" && pairDir
    ? pairDir + "/costs.bin"
    : undefined;
const costBytes = costPath ? await readFile(costPath) : undefined;
if (costBytes && pairs)
  new PairCostTable(costBytes, root.generation, pairs.root.generation);
if (
  bytes.length + (pairBytes?.length ?? 0) + (costBytes?.length ?? 0) >
  Number(budget) * 1048576
)
  throw Error("Combined bundle exceeds budget");
if (!/^[a-z0-9-]{1,48}$/.test(name))
  throw Error("Use a Worker name of 1–48 lowercase letters, digits or hyphens");
await mkdir(dir, { recursive: true });
let token = await readFile(dir + "/token", "utf8").catch(() => "");
if (!token) {
  token = randomBytes(32).toString("hex");
  await writeFile(dir + "/token", token, { mode: 0o600 });
}
const base = {
  compatibility_date: "2026-11-01",
  account_id: process.env.CLOUDFLARE_ACCOUNT_ID,
  workers_dev: true,
  r2_buckets: [{ binding: "INDEX", bucket_name: bucket }],
  limits: { cpu_ms: 300000 },
};
async function wrangler(args: string[], input?: string) {
  return new Promise<string>((done, reject) => {
    const c = spawn(
      process.execPath,
      ["node_modules/wrangler/bin/wrangler.js", ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let text = "";
    c.stdout.on("data", (b) => (text += b));
    c.stderr.on("data", (b) => (text += b));
    c.once("error", reject);
    c.once("exit", (code) => {
      process.stdout.write(text);
      code === 0 ? done(text) : reject(Error("Wrangler failed " + code));
    });
    c.stdin.end(input);
  });
}
const uploadConfig = dir + "/upload.json";
await writeFile(
  uploadConfig,
  JSON.stringify(
    {
      ...base,
      name: name + "-upload",
      main: resolve("src/global/upload-worker.ts"),
    },
    null,
    2,
  ),
);
const deployed = await wrangler(["deploy", "--config", uploadConfig]),
  url = deployed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
if (!url) throw Error("Uploader URL was not returned by Wrangler");
await wrangler(
  ["secret", "put", "UPLOAD_TOKEN", "--config", uploadConfig],
  token,
);
for (const [uploadRoot, packDir] of [
  [root, out + "/packs"],
  ...(pairs && pairDir
    ? [[pairs.root, pairDir + "/packs/" + pairs.root.generation] as const]
    : []),
] as const)
  await parallel(
    uploadRoot.objects.slice(
      uploadRoot === root ? Number(process.env.GLOBAL_FROM_OBJECT ?? 0) : 0,
    ),
    6,
    async (object) => {
      const file = packDir + "/" + object.name,
        hash = createHash("sha256");
      let size = 0;
      for await (const b of createReadStream(file)) {
        hash.update(b);
        size += b.length;
      }
      if (size !== object.size || hash.digest("hex") !== object.sha256)
        throw Error(
          "Global object does not match bundle manifest: " + object.name,
        );
      for (let attempt = 0; ; attempt++) {
        try {
          const address = url + "/" + uploadRoot.generation + "/" + object.name;
          const existing = await fetch(address, {
            method: "HEAD",
            headers: { authorization: `Bearer ${token}` },
          });
          if (existing.ok) {
            if (
              Number(existing.headers.get("content-length")) !== object.size ||
              existing.headers.get("x-sha256") !== object.sha256 ||
              existing.headers.get("x-generation") !== uploadRoot.generation
            )
              throw Error("Immutable remote object mismatch: " + object.name);
            break;
          }
          if (existing.status !== 404)
            throw Error("Global object check failed " + existing.status);
          const r = await fetch(address, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              "content-length": String(size),
              "x-sha256": object.sha256,
            },
            body: createReadStream(file),
            duplex: "half",
          } as any);
          const text = await r.text();
          if (!r.ok) throw Error("Global upload " + r.status + ": " + text);
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      console.log("Ready", object.name);
    },
  );
if (process.argv.includes("--upload-only")) process.exit(0);
const entry = dir + "/entry.ts";
await writeFile(
  entry,
  `import binary from ${JSON.stringify(binaryPath)};import {createGlobalWorker} from ${JSON.stringify(resolve("src/global/worker-runtime.ts"))};${pairDir ? `import pairs from ${JSON.stringify(resolve(pairDir + "/pairs.bin"))};` : ""}${costPath ? `import costs from ${JSON.stringify(resolve(costPath))};` : ""}export default createGlobalWorker(new Uint8Array(binary)${pairDir ? ",new Uint8Array(pairs)" : ""}${costPath ? ",new Uint8Array(costs)" : ""});`,
);
const config = dir + "/search.json";
await writeFile(
  config,
  JSON.stringify(
    {
      ...base,
      name,
      main: entry,
      rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      vars: {
        PAGE_CACHE: "1",
        TOKEN_WINDOWS: process.env.GLOBAL_TOKEN_WINDOWS ?? "0",
        COFETCH_POSITIONS: process.env.GLOBAL_COFETCH_POSITIONS ?? "0",
        COMPLETE_SEEDS: process.env.GLOBAL_COMPLETE_SEEDS ?? "0",
        ADAPTIVE_RETRIEVAL: process.env.GLOBAL_ADAPTIVE_RETRIEVAL ?? "0",
        ADAPTIVE_PROBE: process.env.GLOBAL_ADAPTIVE_PROBE ?? "fused",
        PAIR_INTERSECT: process.env.GLOBAL_PAIR_INTERSECT ?? "0",
        PAGE_READ_KIB: process.env.GLOBAL_PAGE_KIB ?? "256",
        DIAGNOSTICS: "0",
      },
      placement: process.env.GLOBAL_PLACEMENT
        ? process.env.GLOBAL_PLACEMENT === "smart"
          ? { mode: "smart" }
          : { region: process.env.GLOBAL_PLACEMENT }
        : undefined,
    },
    null,
    2,
  ),
);
await wrangler(["deploy", "--config", config]);
await wrangler(["secret", "put", "INTERNAL_TOKEN", "--config", config], token);
console.log(
  "Published immutable global generation",
  root.generation,
  root.count,
);
