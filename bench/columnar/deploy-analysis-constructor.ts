import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const dir = resolve("work/columnar-worker-build/analysis");
await mkdir(dir, { recursive: true });
const auth = await promisify(execFile)(process.execPath, [
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
if (!response.ok) throw Error("Constructor snapshot " + response.status);
const modules: File[] = [];
(await response.formData()).forEach((file, name) => {
  if (name.endsWith(".js") && typeof file !== "string") modules.push(file);
});
if (modules.length !== 1) throw Error("Expected one constructor module");
const core = new Uint8Array(await modules[0].arrayBuffer()),
  hash = createHash("sha256");
async function hashSources(dir: string): Promise<void> {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = dir + "/" + item.name;
    if (item.isDirectory()) await hashSources(path);
    else hash.update(path).update(await readFile(path));
  }
}
await hashSources("src");
for (const file of ["oracle-worker.ts", "oracle-scan.ts", "exhaustive.ts"])
  hash.update(file).update(await readFile("bench/columnar/" + file));
hash.update(await readFile("work/columnar-worker-build/source-root.json"));
const code = hash.digest("hex"),
  config = JSON.parse(
    await readFile(
      "work/columnar-worker-build/work-search-cws-build-0.json",
      "utf8",
    ),
  );
await writeFile(dir + "/core.js", core);
await writeFile(
  dir + "/entry.ts",
  `import core from './core.js';import source from '../source-root.json';import{createConstructionWorker}from ${JSON.stringify(resolve("src/columnar/construction/worker.ts"))};import{createOracleWorker}from ${JSON.stringify(resolve("bench/columnar/oracle-worker.ts"))};const next=createConstructionWorker(source as any,${JSON.stringify(code)}),oracle=createOracleWorker(source as any,${JSON.stringify(code)});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const url=new URL(request.url),updated=url.pathname.startsWith('/stem/');if(updated)url.pathname=url.pathname.slice(5);const target=updated?(url.pathname.startsWith('/oracle')?oracle:next):core,forward=updated?new Request(url,request):request;if(url.pathname.endsWith('health'))return target.fetch(forward,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{return await target.fetch(forward,env);}finally{pending--;release();}}};`,
);
config.main = dir + "/entry.ts";
await writeFile(dir + "/config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const child = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/config.json",
      "--outdir",
      dir + "/dist",
    ],
    { stdio: "inherit" },
  );
  child.once("error", no);
  child.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Analysis constructor deployment " + c)),
  );
});
const result = {
  code,
  coreSha256: createHash("sha256").update(core).digest("hex"),
  prefix: "/stem",
  deployedAt: new Date().toISOString(),
};
await writeFile(dir + "/deployment.json", JSON.stringify(result, null, 2));
console.log(result);
