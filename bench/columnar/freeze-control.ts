import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const commit = "4f97eb49f1aa2115fbc3026c4924a1182a90917b",
  dir = resolve("work/columnar-control"),
  name = "work-search-cws-control";
await mkdir(dir, { recursive: true });
await new Promise<void>((ok, no) => {
  const archive = spawn("git", ["archive", commit, "src"]),
    tar = spawn("tar", ["-x", "-C", dir]);
  archive.stdout.pipe(tar.stdin);
  tar.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Control extraction failed")),
  );
  archive.once("error", no);
  tar.once("error", no);
});
const bundle = resolve("work/global-100k/bundle-heads-8.bin"),
  pairs = resolve("work/pairs-100k-v4096-inline256/pairs.bin");
await writeFile(
  dir + "/entry.ts",
  `import data from ${JSON.stringify(bundle)};import pairs from ${JSON.stringify(pairs)};import {createGlobalWorker} from './src/global/worker-runtime.ts';
const engine=createGlobalWorker(new Uint8Array(data),new Uint8Array(pairs));let isolate;let sequence=0;
export default {async fetch(request,env,ctx){
isolate??=crypto.randomUUID();const start=performance.now(),url=new URL(request.url),requestId=url.searchParams.get('requestId')??crypto.randomUUID(),requestNumber=++sequence;
if(url.pathname==='/search'&&request.method==='POST'&&env.INTERNAL_TOKEN&&request.headers.get('authorization')==='Bearer '+env.INTERNAL_TOKEN){
 const input=await request.clone().json();if(typeof input.cacheNamespace==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(input.cacheNamespace)){const scoped=new URL(url);scoped.hostname=input.cacheNamespace+'.benchmark.invalid';request=new Request(scoped,request);}
}
const r=await engine.fetch(request,env,ctx);if(url.pathname!='/search'||!r.ok)return r;
const result=await r.json(),telemetry={isolate,requestId,requestNumber,wallMs:performance.now()-start};console.log(JSON.stringify({benchmark:telemetry}));return Response.json({...result,telemetry},{headers:{'cache-control':'no-store'}})}};`,
);
const old = JSON.parse(
  await readFile("work/global-deploy/work-search-r2-final-base.json", "utf8"),
);
await writeFile(
  dir + "/wrangler.json",
  JSON.stringify(
    { ...old, name, main: dir + "/entry.ts", observability: { enabled: true } },
    null,
    2,
  ),
);
await writeFile(
  dir + "/manifest.json",
  JSON.stringify(
    {
      commit,
      code: "git archive, unchanged engine; outer telemetry and authenticated cache-namespace wrapper",
      wrapperSha256: createHash("sha256")
        .update(await readFile(dir + "/entry.ts"))
        .digest("hex"),
      bundleSha256: createHash("sha256")
        .update(await readFile(bundle))
        .digest("hex"),
      pairsSha256: createHash("sha256")
        .update(await readFile(pairs))
        .digest("hex"),
      config: { ...old, name, main: "entry.ts" },
    },
    null,
    2,
  ),
);
console.log("Frozen control", dir);
