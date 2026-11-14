import { readFile, writeFile, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";
const dir = resolve("work/live-profile-1m"),
  source = dir + "/source",
  name = "work-search-cws-1m-profile";
await mkdir(dir, { recursive: true });
await cp("work/columnar-deploy/work-search-cws-1m-source", source, {
  recursive: true,
});
const worker = source + "/src/columnar/worker.ts";
let text = await readFile(worker, "utf8");
const marker =
  "            : undefined;\n        if (memory.activeQueries >= 2)";
if (!text.includes(marker))
  throw Error("Frozen instrumentation marker changed");
text =
  `import {instrumentShared} from ${JSON.stringify(resolve("bench/columnar/live-profile-worker.ts"))};\n` +
  text
    .replace("const shared: SharedPages", "let shared: SharedPages")
    .replace(
      "sharedBudget = { remaining: 900 }",
      'sharedBudget = { remaining: Number(request.headers.get("x-profile-shared-budget") ?? 900) }',
    )
    .replace(
      marker,
      "            : undefined;\n        shared = instrumentShared(shared);\n        if (memory.activeQueries >= 2)",
    );
await writeFile(worker, text);
const execution = source + "/src/columnar/packet-execution.ts";
let executionText = await readFile(execution, "utf8");
const decision = '      if (priced.kind !== "documents") {';
if (!executionText.includes(decision))
  throw Error("Continuation marker changed");
executionText =
  `import {noteContinuation} from ${JSON.stringify(resolve("bench/columnar/live-profile-worker.ts"))};\n` +
  executionText.replace(
    decision,
    "      noteContinuation(priced);\n" + decision,
  );
await writeFile(execution, executionText);
let entry = await readFile(
  "work/columnar-deploy/work-search-cws-1m.ts",
  "utf8",
);
entry = entry
  .replaceAll(resolve("work/columnar-deploy/work-search-cws-1m-source"), source)
  .replace(
    "export default createColumnarWorker",
    "const base = createColumnarWorker",
  );
entry =
  `import {installProfile,profileWorker} from ${JSON.stringify(resolve("bench/columnar/live-profile-worker.ts"))};import{Reader,Semaphore}from ${JSON.stringify(source + "/src/columnar/storage.ts")};import{ColumnarR2}from ${JSON.stringify(source + "/src/columnar/r2.ts")};import{objectAt}from ${JSON.stringify(source + "/src/columnar/format.ts")};\n` +
  entry +
  `;installProfile(Reader,Semaphore,ColumnarR2,(r:any)=>{const o=objectAt(root as any,r[0]);return o.key??root.generation+'/'+o.name;});export default profileWorker(base);`;
await writeFile(dir + "/entry.ts", entry);
const config = JSON.parse(
  await readFile("work/columnar-deploy/work-search-cws-1m.json", "utf8"),
);
config.name = name;
config.main = dir + "/entry.ts";
config.compatibility_flags = ["nodejs_als"];
config.vars.CACHE_NAMESPACE = name;
await writeFile(
  "work/columnar-deploy/" + name + ".json",
  JSON.stringify(config, null, 2),
);
async function wrangler(args: string[], input?: string) {
  await new Promise<void>((ok, no) => {
    const c = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    c.stdin.end(input);
    c.on("error", no);
    c.on("exit", (code) => (code === 0 ? ok() : no(Error("Wrangler " + code))));
  });
}
await wrangler([
  "deploy",
  "--config",
  "work/columnar-deploy/" + name + ".json",
]);
await wrangler(
  [
    "secret",
    "put",
    "INTERNAL_TOKEN",
    "--config",
    "work/columnar-deploy/" + name + ".json",
  ],
  await benchmarkToken(),
);
