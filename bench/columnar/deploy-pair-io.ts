import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const dir = "work/columnar-worker-build",
  config = JSON.parse(
    await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
  ),
  hash = createHash("sha256");
for (const file of [
  "src/columnar/construction/pair-statistics-runs.ts",
  "src/columnar/construction/pair-statistics.ts",
  "src/columnar/construction/runs.ts",
  "src/columnar/format.ts",
  "bench/columnar/pair-io-worker.ts",
])
  hash.update(file).update(await readFile(file));
const code = hash.digest("hex"),
  frozenSha256 = createHash("sha256")
    .update(await readFile(dir + "/frozen-pair-core.js"))
    .digest("hex");
await writeFile(
  dir + "/pair-io-entry.ts",
  `import core from './frozen-pair-core.js';import{createPairIOWorker}from ${JSON.stringify(resolve("bench/columnar/pair-io-worker.ts"))};const io=createPairIOWorker(${JSON.stringify(code)});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const p=new URL(request.url).pathname;if(['/health','/pair-health','/group-health'].includes(p))return core.fetch(request,env);if(p==='/pair-io-health')return io.fetch(request,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{return await(p==='/merge-pair-statistics-io'?io:core).fetch(request,env);}finally{pending--;release();}}};`,
);
config.main = resolve(dir + "/pair-io-entry.ts");
await writeFile(dir + "/pair-io-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const p = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/pair-io-config.json",
      "--outdir",
      dir + "/pair-io-dist",
    ],
    { stdio: "inherit" },
  );
  p.once("error", no);
  p.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Pair I/O deployment failed " + c)),
  );
});
console.log(JSON.stringify({ code, frozenSha256 }));
