import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { benchmarkToken } from "./token.js";
const dir = "work/columnar-worker-build",
  url = "https://work-search-cws-build-0.phulin.workers.dev",
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
if (!response.ok) throw Error("Constructor snapshot " + response.status);
const modules: File[] = [];
(await response.formData()).forEach((file, name) => {
  if (name.endsWith(".js") && typeof file !== "string") modules.push(file);
});
if (modules.length !== 1) throw Error("Expected one constructor module");
const bytes = new Uint8Array(await modules[0].arrayBuffer()),
  hash = createHash("sha256");
for (const file of [
  "bench/columnar/pair-expanded-worker.ts",
  "src/columnar/construction/pair-jobs.ts",
  "src/columnar/construction/pair-directory-job.ts",
  "src/columnar/construction/pair-occurrences.ts",
  "src/columnar/pair-directory.ts",
  "src/columnar/pair-packet.ts",
  "src/columnar/storage.ts",
  "src/columnar/format.ts",
  "src/columnar/construction/finish.ts",
  "src/columnar/construction/runs.ts",
])
  hash.update(file).update(await readFile(file));
const code = hash.digest("hex"),
  benchmark = await benchmarkToken(),
  health = (await fetch(url + "/pair-health", {
    headers: { authorization: `Bearer ${benchmark}` },
  }).then((r) => r.json())) as any,
  config = JSON.parse(
    await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
  );
if (!/^[a-f0-9]{64}$/.test(health.code))
  throw Error("Missing frozen statistics code");
await writeFile(dir + "/frozen-expanded-core.js", bytes);
await writeFile(
  dir + "/expanded-entry.ts",
  `import core from './frozen-expanded-core.js';import{createExpandedPairWorker}from ${JSON.stringify(resolve("bench/columnar/pair-expanded-worker.ts"))};const pairs=createExpandedPairWorker(${JSON.stringify(code)},${JSON.stringify(health.code)});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const p=new URL(request.url).pathname;if(['/health','/pair-health','/group-health','/pair-io-health','/oracle-health','/pair-range-health'].includes(p))return core.fetch(request,env);if(p==='/expanded-pair-health')return pairs.fetch(request,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{return await(p.startsWith('/expanded-')?pairs:core).fetch(request,env);}finally{pending--;release();}}};`,
);
config.main = resolve(dir + "/expanded-entry.ts");
await writeFile(dir + "/expanded-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const child = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/expanded-config.json",
      "--outdir",
      dir + "/expanded-dist",
    ],
    { stdio: "inherit" },
  );
  child.once("error", no);
  child.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Expanded pair deploy " + c)),
  );
});
console.log({
  code,
  statisticsCode: health.code,
  coreSha256: createHash("sha256").update(bytes).digest("hex"),
});
