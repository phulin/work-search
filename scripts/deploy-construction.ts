import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "../bench/columnar/token.js";
const dir = resolve("work/columnar-worker-build"),
  name = process.argv[2] ?? "work-search-cws-build-0";
if (!/^work-search-cws-build-\d+$/.test(name))
  throw Error("Use an isolated construction Worker name");
await mkdir(dir, { recursive: true });
const hash = createHash("sha256");
async function hashSources(dir: string): Promise<void> {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = dir + "/" + item.name;
    if (item.isDirectory()) await hashSources(path);
    else hash.update(path).update(await readFile(path));
  }
}
await hashSources("src");
hash.update(await readFile(dir + "/source-root.json"));
const code = hash.digest("hex"),
  entry = dir + "/entry.ts";
await writeFile(
  entry,
  `import root from './source-root.json';import{createConstructionWorker}from'../../src/columnar/construction/worker.ts';export default createConstructionWorker(root as any,${JSON.stringify(code)});`,
);
const settings = (name: string, main: string) => ({
  name,
  main,
  account_id: "8f088d4bd190caf693cc42bb8311fd7d",
  compatibility_date: "2026-11-01",
  workers_dev: true,
  placement: { region: "aws:us-east-1" },
  r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
  limits: { cpu_ms: 300000 },
  observability: { enabled: true },
});
const token = await benchmarkToken();
async function wrangler(args: string[], input?: string) {
  for (let retry = 0; ; retry++)
    try {
      await new Promise<void>((ok, no) => {
        const p = spawn("yarn", ["wrangler", ...args], {
          stdio: ["pipe", "inherit", "inherit"],
        });
        p.stdin.end(input);
        p.once("error", no);
        p.once("exit", (c) =>
          c === 0 ? ok() : no(Error("Construction deployment failed " + c)),
        );
      });
      return;
    } catch (error) {
      if (retry === 4) throw error;
      // Fresh scripts can briefly return API 10007 after a successful upload.
      // Retrying the same immutable deployment also handles transient API errors.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** retry));
    }
}
const bundleConfig = dir + "/bundle.json",
  bundle = dir + "/dist";
await writeFile(bundleConfig, JSON.stringify(settings(name, entry), null, 2));
await wrangler([
  "deploy",
  "--config",
  bundleConfig,
  "--dry-run",
  "--outdir",
  bundle,
]);
const config = dir + "/" + name + ".json";
await writeFile(
  config,
  JSON.stringify(settings(name, bundle + "/entry.js"), null, 2),
);
await wrangler(["deploy", "--config", config]);
await wrangler(["secret", "put", "INTERNAL_TOKEN", "--config", config], token);
console.log(
  JSON.stringify({
    name,
    code,
    source: dir + "/source-root.json",
    placement: "aws:us-east-1",
  }),
);
