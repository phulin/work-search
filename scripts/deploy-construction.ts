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
const config = dir + "/" + name + ".json";
await writeFile(
  config,
  JSON.stringify(
    {
      name,
      main: entry,
      account_id: "8f088d4bd190caf693cc42bb8311fd7d",
      compatibility_date: "2026-11-01",
      workers_dev: true,
      r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
      limits: { cpu_ms: 300000 },
      observability: { enabled: true },
    },
    null,
    2,
  ),
);
const token = await benchmarkToken();
for (const args of [
  ["deploy", "--config", config],
  ["secret", "put", "INTERNAL_TOKEN", "--config", config],
])
  await new Promise<void>((ok, no) => {
    const p = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    p.stdin.end(args[0] === "secret" ? token : undefined);
    p.once("error", no);
    p.once("exit", (c) =>
      c === 0 ? ok() : no(Error("Construction deployment failed " + c)),
    );
  });
console.log(JSON.stringify({ name, code, source: dir + "/source-root.json" }));
