import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const dir = "work/columnar-worker-build/word-constructor",
  sourceDir = process.argv[2];
if (!sourceDir) throw Error("Use SOURCE_BUILD");
const state = JSON.parse(await readFile(sourceDir + "/build.json", "utf8"));
if (
  !state.vocabularies.length ||
  state.vocabularies.some((j: any) => j.next !== j.end) ||
  state.vocabularies.reduce((n: number, j: any) => n + j.end - j.first, 0) !==
    state.count
)
  throw Error("Vocabulary construction is incomplete");
const metadata = JSON.parse(await readFile(dir + "/deployment.json", "utf8")),
  core = await readFile(dir + "/frozen-core.js");
if (createHash("sha256").update(core).digest("hex") !== metadata.coreSha256)
  throw Error("Frozen constructor digest mismatch");
const config = JSON.parse(await readFile(dir + "/config.json", "utf8"));
config.main = resolve(dir + "/frozen-core.js");
delete config.rules;
await writeFile(dir + "/restore-config.json", JSON.stringify(config, null, 2));
await new Promise<void>((ok, no) => {
  const p = spawn(
    "yarn",
    [
      "wrangler",
      "deploy",
      "--config",
      dir + "/restore-config.json",
      "--outdir",
      dir + "/restored-dist",
    ],
    { stdio: "inherit" },
  );
  p.once("error", no);
  p.once("exit", (c) =>
    c === 0 ? ok() : no(Error("Constructor restore " + c)),
  );
});
await writeFile(
  dir + "/restored.json",
  JSON.stringify(
    {
      restoredAt: new Date().toISOString(),
      coreSha256: metadata.coreSha256,
      removedBundleBytes: metadata.wordDirectoryBytes,
      vocabularyDocuments: state.count,
    },
    null,
    2,
  ),
);
console.log(
  "Removed construction vocabulary bundle after complete coverage",
  state.count,
);
