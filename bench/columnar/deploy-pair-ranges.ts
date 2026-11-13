import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const dir = "work/columnar-worker-build",
  auth = await promisify(execFile)(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "auth",
    "token",
    "--json",
  ]),
  token = JSON.parse(auth.stdout).token,
  response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/8f088d4bd190caf693cc42bb8311fd7d/workers/scripts/work-search-cws-build-0/content/v2",
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
if (!response.ok) throw Error("Constructor download " + response.status);
const modules: File[] = [];
(await response.formData()).forEach((file, name) => {
  if (name.endsWith(".js") && typeof file !== "string") modules.push(file);
});
if (modules.length !== 1) throw Error("Expected one constructor module");
const bytes = new Uint8Array(await modules[0].arrayBuffer()),
  hash = createHash("sha256");
for (const file of [
  "bench/columnar/pair-range-worker.ts",
  "src/columnar/construction/pair-range-jobs.ts",
  "src/columnar/construction/pair-occurrences.ts",
  "src/columnar/construction/runs.ts",
  "src/columnar/pair-packet.ts",
  "src/columnar/format.ts",
])
  hash.update(file).update(await readFile(file));
const code = hash.digest("hex"),
  config = JSON.parse(
    await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
  );
await writeFile(dir + "/frozen-range-core.js", bytes);
await writeFile(
  dir + "/range-entry.ts",
  `import core from './frozen-range-core.js';import{createPairRangeWorker}from ${JSON.stringify(resolve("bench/columnar/pair-range-worker.ts"))};const ranges=createPairRangeWorker(${JSON.stringify(code)});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const p=new URL(request.url).pathname;if(['/health','/pair-health','/group-health','/pair-io-health','/oracle-health'].includes(p))return core.fetch(request,env);if(p==='/pair-range-health')return ranges.fetch(request,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{return await(['/pair-restarts','/merge-pair-occurrences-range'].includes(p)?ranges:core).fetch(request,env);}finally{pending--;release();}}};`,
);
config.main = resolve(dir + "/range-entry.ts");
await writeFile(dir + "/range-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const p = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/range-config.json",
      "--outdir",
      dir + "/range-dist",
    ],
    { stdio: "inherit" },
  );
  p.once("error", no);
  p.once("exit", (c) => (c === 0 ? ok() : no(Error("Range deployment " + c))));
});
console.log(
  JSON.stringify({
    code,
    coreSha256: createHash("sha256").update(bytes).digest("hex"),
  }),
);
