import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
// Temporary bridge while a full source build is running. Its original compiled
// constructor and acknowledgement identities stay unchanged. New deployments
// after that build completes use scripts/deploy-construction.ts directly.
const dir = "work/columnar-worker-build",
  config = JSON.parse(
    await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
  ),
  hash = createHash("sha256");
async function sources(path: string): Promise<void> {
  for (const entry of (await readdir(path, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path + "/" + entry.name;
    if (entry.isDirectory()) await sources(file);
    else hash.update(file).update(await readFile(file));
  }
}
await sources("src");
hash.update(await readFile(dir + "/source-root.json"));
const pairCode = hash.digest("hex"),
  coreSha256 = createHash("sha256")
    .update(await readFile(dir + "/dist/entry.js"))
    .digest("hex");
await writeFile(
  dir + "/pair-entry.ts",
  `
import core from './dist/entry.js';
import root from './source-root.json';
import {createConstructionWorker} from ${JSON.stringify(resolve("src/columnar/construction/worker.ts"))};
const pairs=createConstructionWorker(root as any,${JSON.stringify(pairCode)});
let pending=0,tail=Promise.resolve();
export default {async fetch(request,env){
 const p=new URL(request.url).pathname;
 if(p==='/health'||p==='/group-health')return core.fetch(request,env);
 if(p==='/pair-health'){const u=new URL(request.url);u.pathname='/health';return pairs.fetch(new Request(u,request),env);}
 if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});
 if(pending>=4)return new Response('Construction capacity busy',{status:503,headers:{'retry-after':'1'}});
 const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;
 try{return await (['/pair-statistics','/merge-pair-statistics','/pair-occurrences','/merge-pair-occurrences','/finish-pairs'].includes(p)?pairs:core).fetch(request,env);}
 finally{pending--;release();}
}};
`,
);
config.main = resolve(dir + "/pair-entry.ts");
await writeFile(dir + "/pair-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const p = spawn(
    "yarn",
    ["wrangler", "deploy", "--config", dir + "/pair-config.json"],
    { stdio: "inherit" },
  );
  p.once("error", no);
  p.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Pair constructor deployment failed " + c)),
  );
});
console.log(
  JSON.stringify({ pairCode, coreSha256, frozenCore: dir + "/dist/entry.js" }),
);
