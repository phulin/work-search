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
    { headers: { authorization: `Bearer ${token}` } },
  );
if (!response.ok) throw Error("Active constructor download " + response.status);
const modules: File[] = [];
(await response.formData()).forEach((file, name) => {
  if (name.endsWith(".js") && typeof file !== "string") modules.push(file);
});
if (modules.length !== 1)
  throw Error("Expected a single compiled constructor module");
const bytes = new Uint8Array(await modules[0].arrayBuffer()),
  coreSha256 = createHash("sha256").update(bytes).digest("hex"),
  hash = createHash("sha256");
for (const file of [
  "bench/columnar/oracle-worker.ts",
  "bench/columnar/oracle-scan.ts",
  "bench/columnar/exhaustive.ts",
  "src/query/tokenize.ts",
  "src/query/parser.ts",
  "src/columnar/construction/source.ts",
  "src/columnar/construction/runs.ts",
])
  hash.update(file).update(await readFile(file));
const code = hash.digest("hex"),
  source = JSON.parse(await readFile(dir + "/source-root.json", "utf8")),
  config = JSON.parse(
    await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
  );
// Preserve the already running construction handlers byte for byte. Remove
// this migration wrapper after their immutable generations have completed.
await writeFile(dir + "/frozen-oracle-core.js", bytes);
await writeFile(
  dir + "/oracle-entry.ts",
  `import core from './frozen-oracle-core.js';import{createOracleWorker}from ${JSON.stringify(resolve("bench/columnar/oracle-worker.ts"))};const oracle=createOracleWorker(${JSON.stringify(source)},${JSON.stringify(code)});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const p=new URL(request.url).pathname;if(['/health','/pair-health','/group-health','/pair-io-health'].includes(p))return core.fetch(request,env);if(p==='/oracle-health')return oracle.fetch(request,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{return await(p==='/oracle-scan'?oracle:core).fetch(request,env);}finally{pending--;release();}}};`,
);
config.main = resolve(dir + "/oracle-entry.ts");
await writeFile(dir + "/oracle-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const p = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/oracle-config.json",
      "--outdir",
      dir + "/oracle-dist",
    ],
    { stdio: "inherit" },
  );
  p.once("error", no);
  p.once("exit", (c) => (c === 0 ? ok() : no(Error("Oracle deployment " + c))));
});
console.log(JSON.stringify({ code, coreSha256 }));
