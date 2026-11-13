import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { Miniflare } from "miniflare";
import "./workerd-runtime.js";
import { crc32 } from "../src/format/codec.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { benchmarkToken } from "../bench/columnar/token.js";
const dir = resolve(process.argv[2] ?? "indexes/cws");
await mkdir("work/columnar-local", { recursive: true });
const temp = await mkdtemp(resolve("work/columnar-local/runtime-"));
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  pairs = await readFile(dir + "/pairs-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  ),
  heads = await readFile(dir + "/heads-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  ),
  remote = process.env.CWS_REMOTE_URL
    ? { url: process.env.CWS_REMOTE_URL, token: await benchmarkToken() }
    : undefined,
  objects = new OfflineObjects(dir, root, remote),
  pairObjects = pairs
    ? new OfflineObjects(dir + "/pairs", pairs, remote)
    : undefined;
await writeFile(
  temp + "/entry.ts",
  `import root from ${JSON.stringify(dir + "/root.json")};${pairs ? `import pairs from ${JSON.stringify(dir + "/pairs-root.json")};` : ""}${heads ? `import hr from ${JSON.stringify(dir + "/heads-root.json")};import hd from ${JSON.stringify(dir + "/heads.bin")};` : ""}${root.directory ? `import td from ${JSON.stringify(dir + "/directory.bin")};` : ""}${root.documentPackages?.locators ? `import dd from ${JSON.stringify(dir + "/documents.bin")};` : ""}import{createColumnarWorker}from ${JSON.stringify(resolve("src/columnar/worker.ts"))};const worker=createColumnarWorker(root,${pairs ? "pairs" : "undefined"},${heads ? "{root:hr,data:new Uint8Array(hd)}" : "undefined"},${root.directory ? "new Uint8Array(td)" : "undefined"},${root.documentPackages?.locators ? "new Uint8Array(dd)" : "undefined"});export default{fetch(request,env,ctx){return worker.fetch(request,{...env,INDEX:{async get(key,options){const r=await env.FILES.fetch('http://files/'+key,{headers:{offset:String(options.range.offset),length:String(options.range.length)}});if(!r.ok)throw Error('Local object '+r.status);return{customMetadata:r.headers.has('x-cws-meta')?JSON.parse(r.headers.get('x-cws-meta')):{generation:key.split('/')[0],sha256:r.headers.get('x-sha256'),crc32:r.headers.get('x-page-crc32')},arrayBuffer:()=>r.arrayBuffer()};}}},ctx);}};`,
);
await writeFile(
  temp + "/wrangler.json",
  JSON.stringify({
    name: "cws-local",
    main: temp + "/entry.ts",
    compatibility_date: "2026-11-01",
    rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
  }),
);
const dry = spawnSync(
  "yarn",
  [
    "wrangler",
    "deploy",
    "--config",
    temp + "/wrangler.json",
    "--dry-run",
    "--outdir",
    temp + "/dist",
  ],
  { encoding: "utf8" },
);
if (dry.status) throw Error(dry.stdout + dry.stderr);
const packageMetadata = new WeakMap<Uint8Array, Record<string, string>>();
const mf = new Miniflare({
  compatibilityDate: "2026-11-01",
  compatibilityFlags: ["nodejs_compat"],
  modules: true,
  modulesRoot: temp,
  modulesRules: [{ type: "Data", include: ["**/*.bin"], fallthrough: true }],
  scriptPath: temp + "/dist/entry.js",
  bindings: { INTERNAL_TOKEN: "local", PAGE_CACHE: "1" },
  serviceBindings: {
    FILES: async (request: Request) => {
      const key = new URL(request.url).pathname.slice(1),
        sources = [objects, pairObjects].filter(Boolean) as OfflineObjects[],
        source = sources.find((s) =>
          s.root.objects.some(
            (o) => (o.key ?? `${s.root.generation}/${o.name}`) === key,
          ),
        );
      if (!source && root.documentPackages?.locators) {
        const full = await objects.readGroup(key);
        let meta = packageMetadata.get(full);
        if (!meta) {
          const v = new DataView(full.buffer, full.byteOffset, full.byteLength),
            checksums: number[] = [];
          let at = 0,
            first = -1;
          while (at < full.length) {
            if (at + 64 > full.length || v.getUint32(at, true) !== 0x32504443)
              throw Error("Invalid local package group");
            const doc = v.getUint32(at + 4, true),
              n = v.getUint32(at + 56, true) + v.getUint32(at + 60, true);
            if (first < 0) first = doc;
            if (
              doc !== first + checksums.length ||
              n < 64 ||
              at + n > full.length
            )
              throw Error("Invalid local package coverage");
            checksums.push(crc32(full.subarray(at, at + n)));
            at += n;
          }
          meta = {
            generation: key.split("/")[0],
            sha256: key.split("/")[0],
            packageFirst: String(first),
            packageEnd: String(first + checksums.length),
            packageCrc32: Buffer.from(
              Uint32Array.from(checksums).buffer,
            ).toString("base64"),
          };
          packageMetadata.set(full, meta);
        }
        const offset = Number(request.headers.get("offset")),
          length = Number(request.headers.get("length"));
        if (offset < 0 || length < 1 || offset + length > full.length)
          throw Error("Invalid local package range");
        return new Response(
          full.subarray(offset, offset + length) as BodyInit,
          { headers: { "x-cws-meta": JSON.stringify(meta) } },
        );
      }
      if (!source)
        return new Response("Missing local generation", { status: 404 });
      const object = source.root.objects.find(
        (o) => (o.key ?? `${source.root.generation}/${o.name}`) === key,
      )!;
      let checksums = object.checksums;
      if (!checksums) {
        // Offline validation is allowed to read the whole immutable object once.
        const full = await source.readKey(key, 0, object.size);
        checksums = [];
        for (let at = 0; at < full.length; at += 262144)
          checksums.push(crc32(full.subarray(at, at + 262144)));
        object.checksums = checksums;
      }
      return new Response(
        (await source.readKey(
          key,
          Number(request.headers.get("offset")),
          Number(request.headers.get("length")),
        )) as BodyInit,
        {
          headers: {
            "x-sha256": object.sha256,
            "x-page-crc32": Buffer.from(
              Uint32Array.from(checksums).buffer,
            ).toString("base64"),
          },
        },
      );
    },
  },
});
await mf.ready;
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const r = await mf.dispatchFetch("http://local" + req.url, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) Readable.fromWeb(r.body as any).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1", () =>
  console.log(
    "Local workerd search: http://127.0.0.1:" +
      String(process.env.PORT ?? 8787) +
      "/search?q=court",
  ),
);
async function close() {
  server.close();
  await mf.dispose();
  await objects.close();
  await pairObjects?.close();
  await rm(temp, { recursive: true, force: true });
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
