import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";
const [deployment, name] = process.argv.slice(2);
if (!deployment || !/^work-search-cws-fresh-[a-z0-9-]+$/.test(name ?? ""))
  throw Error("Use EXISTING_DEPLOYMENT_DIRECTORY NEW_ISOLATED_NAME");
const original = JSON.parse(
  await readFile(deployment + "/wrangler.json", "utf8"),
);
if (name === original.name)
  throw Error("Choose a separate name for the compiled control");
const dir = resolve("work/construction-v3/deploy/" + name);
await mkdir(dir, { recursive: true });
const compiled = await readFile(deployment + "/dist/entry.js");
const config = {
  ...original,
  name,
  main: resolve(deployment + "/dist/entry.js"),
};
await writeFile(dir + "/wrangler.json", JSON.stringify(config, null, 2));
async function run(args: string[], input?: string) {
  await new Promise<void>((ok, no) => {
    const child = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.end(input);
    child.once("error", no);
    child.once("exit", (c) =>
      c === 0 ? ok() : no(Error("Wrangler exit " + c)),
    );
  });
}
await run([
  "deploy",
  "--config",
  dir + "/wrangler.json",
  "--outdir",
  dir + "/dist",
]);
await run(
  ["secret", "put", "INTERNAL_TOKEN", "--config", dir + "/wrangler.json"],
  await benchmarkToken(),
);
await writeFile(
  dir + "/manifest.json",
  JSON.stringify({
    name,
    deployment,
    compiledSha256: createHash("sha256").update(compiled).digest("hex"),
    deployedAt: new Date().toISOString(),
  }),
);
console.log("Deployed compiled control", name);
