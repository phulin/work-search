import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const [buildDir, size = "2048", wordDir = buildDir + "/words"] =
  process.argv.slice(2);
const activate = process.argv.includes("--activate");
if (!buildDir || ![256, 512, 1024, 2048].includes(Number(size)))
  throw Error("Use SOURCE_BUILD BLOCK_SIZE");
const dir = "work/columnar-worker-build/word-constructor";
await mkdir(dir, { recursive: true });
const state = JSON.parse(await readFile(buildDir + "/build.json", "utf8")),
  manifest = JSON.parse(await readFile(wordDir + "/manifest.json", "utf8")),
  selected = manifest.variants.find((v: any) => v.blockSize === Number(size)),
  data = await readFile(wordDir + `/words-${size}.bin`),
  sha256 = createHash("sha256").update(data).digest("hex");
if (
  manifest.sourceRoot.sha256 !== state.rootRef.sha256 ||
  manifest.count !== state.terms ||
  sha256 !== selected.sha256 ||
  data.length !== selected.bytes
)
  throw Error("Word directory source mismatch");
const source = JSON.parse(
  await readFile("work/columnar-worker-build/source-root.json", "utf8"),
);
const auth = await promisify(execFile)(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "auth",
    "token",
    "--json",
  ]),
  token = JSON.parse(auth.stdout).token;
let core: Uint8Array | undefined = await readFile(
  dir + "/frozen-core.js",
).catch(() => undefined);
if (!core) {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/8f088d4bd190caf693cc42bb8311fd7d/workers/scripts/work-search-cws-build-0/content/v2",
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw Error("Constructor snapshot " + response.status);
  const modules: File[] = [];
  (await response.formData()).forEach((file, name) => {
    if (name.endsWith(".bin"))
      throw Error("Expected constructor without a word bundle");
    if (name.endsWith(".js") && typeof file !== "string") modules.push(file);
  });
  if (modules.length !== 1)
    throw Error("Expected pre-vocabulary constructor module");
  core = new Uint8Array(await modules[0].arrayBuffer());
  await writeFile(dir + "/frozen-core.js", core);
}
if (core.length + data.length > 63 * 1048576)
  throw Error("Constructor data exceeds the Worker bundle budget");
const hash = createHash("sha256").update(sha256).update(state.sourceHash);
for (const file of [
  "bench/columnar/vocabulary-worker.ts",
  "src/columnar/construction/vocabulary.ts",
  "src/columnar/word-directory.ts",
  "src/columnar/dictionary.ts",
  "src/columnar/storage.ts",
  "src/columnar/construction/source.ts",
  "src/columnar/construction/runs.ts",
])
  hash.update(file).update(await readFile(file));
const code = hash.digest("hex");
await writeFile(dir + "/words.bin", data);
await writeFile(
  dir + "/entry.ts",
  `import core from './frozen-core.js';import words from './words.bin';import{createVocabularyWorker}from ${JSON.stringify(resolve("bench/columnar/vocabulary-worker.ts"))};const next=createVocabularyWorker(${JSON.stringify(source)},${JSON.stringify(code)},{data:new Uint8Array(words),generation:${JSON.stringify(state.sourceHash)},count:${state.count},rootSha256:${JSON.stringify(state.rootRef.sha256)}});let pending=0,tail=Promise.resolve();export default{async fetch(request,env){const p=new URL(request.url).pathname;if(p.endsWith('health'))return(p==='/vocabulary-bundled-health'?next:core).fetch(request,env);if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});if(pending>=4)return new Response('Construction capacity busy',{status:503});const previous=tail;let release;tail=new Promise(r=>release=r);pending++;await previous;try{const selected=p==='/vocabulary-bundled'||(${activate}&&p==='/vocabulary'&&(await request.clone().json()).rootRef?.sha256===${JSON.stringify(state.rootRef.sha256)});return await(selected?next:core).fetch(request,env);}finally{pending--;release();}}};`,
);
const config = JSON.parse(
  await readFile(
    "work/columnar-worker-build/work-search-cws-build-0.json",
    "utf8",
  ),
);
config.main = resolve(dir + "/entry.ts");
config.rules = [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }];
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
    c === 0 ? ok() : no(Error("Word constructor deployment " + c)),
  );
});
const result = {
  code,
  coreSha256: createHash("sha256").update(core).digest("hex"),
  wordDirectorySha256: sha256,
  wordDirectoryBytes: data.length,
  sourceGeneration: state.sourceHash,
  count: state.count,
  terms: manifest.count,
  blockSize: Number(size),
  activated: activate,
  deployedAt: new Date().toISOString(),
};
await writeFile(dir + "/deployment.json", JSON.stringify(result, null, 2));
console.log(result);
