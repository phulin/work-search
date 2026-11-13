import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
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
  "bench/columnar/vocabulary-worker.ts",
  "src/columnar/construction/vocabulary.ts",
  "src/columnar/dictionary.ts",
  "src/columnar/storage.ts",
  "src/columnar/construction/source.ts",
  "src/columnar/construction/runs.ts",
])
  hash.update(file).update(await readFile(file));
const code = hash.digest("hex");
const source = JSON.parse(await readFile(dir + "/source-root.json", "utf8"));
const config = JSON.parse(
  await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
);
await writeFile(dir + "/frozen-vocabulary-core.js", bytes);
await writeFile(
  dir + "/vocabulary-entry.ts",
  `import core from './frozen-vocabulary-core.js';import{createVocabularyWorker}from ${JSON.stringify(resolve("bench/columnar/vocabulary-worker.ts"))};const next=createVocabularyWorker(${JSON.stringify(source)},${JSON.stringify(code)});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const p=new URL(request.url).pathname;if(p.endsWith('health'))return(p==='/vocabulary-once-health'?next:core).fetch(request,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{return await(p==='/vocabulary-once'?next:core).fetch(request,env);}finally{pending--;release();}}};`,
);
config.main = resolve(dir + "/vocabulary-entry.ts");
await writeFile(
  dir + "/vocabulary-config.json",
  JSON.stringify(config, null, 2),
);
await new Promise<void>((ok, no) => {
  const child = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/vocabulary-config.json",
      "--outdir",
      dir + "/vocabulary-dist",
    ],
    { stdio: "inherit" },
  );
  child.once("error", no);
  child.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Vocabulary deploy " + c)),
  );
});
console.log({
  code,
  coreSha256: createHash("sha256").update(bytes).digest("hex"),
});
