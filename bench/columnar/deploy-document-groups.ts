import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
// Add a transport endpoint without changing the frozen sorting core of an
// in-progress build. Fresh deployments use the normal construction entry point.
const dir = "work/columnar-worker-build",
  config = JSON.parse(
    await readFile(dir + "/work-search-cws-build-0.json", "utf8"),
  );
const files = [
    "src/columnar/document-package.ts",
    "src/columnar/construction/document-groups.ts",
    "src/columnar/construction/package-documents.ts",
    "src/columnar/construction/vocabulary.ts",
    "src/columnar/construction/text.ts",
  ],
  hash = createHash("sha256");
for (const file of files) hash.update(await readFile(file));
const code = hash.digest("hex");
await writeFile(
  dir + "/group-entry.ts",
  `import core from './dist/entry.js';import source from './source-root.json';import{createDocumentGroupHandler}from ${JSON.stringify(resolve("src/columnar/construction/document-groups.ts"))};const groups=createDocumentGroupHandler(source as any,${JSON.stringify(code)});export default {fetch(request,env){const p=new URL(request.url).pathname;return p==='/group-health'||p==='/grouped-documents'?groups.fetch(request,env):core.fetch(request,env);}};`,
);
config.main = resolve(dir + "/group-entry.ts");
await writeFile(dir + "/group-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const p = spawn(
    "yarn",
    ["wrangler", "deploy", "--config", dir + "/group-config.json"],
    { stdio: "inherit" },
  );
  p.once("error", no);
  p.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Grouped constructor deployment failed " + c)),
  );
});
console.log(
  JSON.stringify({ groupCode: code, frozenCore: dir + "/dist/entry.js" }),
);
