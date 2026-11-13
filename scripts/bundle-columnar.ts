import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const dir = resolve(process.argv[2] ?? "indexes/cws"),
  out = resolve("work/columnar-deploy/local"),
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  pairs = await readFile(dir + "/pairs-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  ),
  heads = await readFile(dir + "/heads-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  );
if (
  (pairs && pairs.baseGeneration !== root.generation) ||
  (heads && heads.baseGeneration !== root.generation)
)
  throw Error("Generation mismatch");
await mkdir(out, { recursive: true });
await writeFile(
  out + "/entry.ts",
  `import root from ${JSON.stringify(dir + "/root.json")};${pairs ? `import pairs from ${JSON.stringify(dir + "/pairs-root.json")};` : ""}${heads ? `import heads from ${JSON.stringify(dir + "/heads-root.json")};import data from ${JSON.stringify(dir + "/heads.bin")};` : ""}import{createColumnarWorker}from ${JSON.stringify(resolve("src/columnar/worker.ts"))};export default createColumnarWorker(root as any,${pairs ? "pairs as any" : "undefined"}${heads ? ",{root:heads as any,data:new Uint8Array(data)}" : ""});`,
);
await new Promise<void>((ok, no) => {
  const child = spawn(
    "yarn",
    ["wrangler", "deploy", "--dry-run", "--outdir", "dist"],
    { stdio: "inherit" },
  );
  child.once("error", no);
  child.once("exit", (code) =>
    code === 0 ? ok() : no(Error("Bundle failed " + code)),
  );
});
