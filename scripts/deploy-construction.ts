import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "../bench/columnar/token.js";
import { ENGLISH_ANALYSIS } from "../src/query/analysis.js";
const dir = resolve("work/columnar-worker-build"),
  name = process.argv[2] ?? "work-search-cws-build-0";
if (!/^work-search-cws-build-\d+$/.test(name))
  throw Error("Use an isolated construction Worker name");
await mkdir(dir, { recursive: true });
if (process.env.CWS_SOURCE_ROOT)
  await writeFile(
    dir + "/source-root.json",
    await readFile(process.env.CWS_SOURCE_ROOT),
  );
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
const wordDir = process.env.CWS_CONSTRUCTION_WORDS;
let vocabulary: any;
if (wordDir) {
  const metadata = await readFile(wordDir + "/manifest.json"),
    manifest = JSON.parse(metadata.toString()),
    hot = await readFile(wordDir + "/hot.bin"),
    ids = await readFile(wordDir + "/ids.bin"),
    sourceRoot = JSON.parse(await readFile(dir + "/source-root.json", "utf8")),
    sourceHash = createHash("sha256")
      .update(JSON.stringify({ sourceRoot, count: manifest.count }))
      .digest("hex"),
    generation = createHash("sha256")
      .update(JSON.stringify({ sourceHash, analysis: ENGLISH_ANALYSIS }))
      .digest("hex"),
    digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  if (
    manifest.generation !== generation ||
    manifest.count > sourceRoot.documents ||
    hot.length !== manifest.hotBytes ||
    ids.length !== manifest.idsBytes ||
    digest(hot) !== manifest.hotSha256 ||
    digest(ids) !== manifest.idsSha256 ||
    hot.length + ids.length > 16 * 1048576
  )
    throw Error("Construction word bundle source or budget mismatch");
  vocabulary = {
    generation,
    count: manifest.count,
    rootSha256: manifest.rootSha256,
    packets: manifest.packets,
  };
  hash.update(metadata).update(hot).update(ids);
  await writeFile(dir + "/hot.bin", hot);
  await writeFile(dir + "/ids.bin", ids);
}
const code = hash.digest("hex"),
  entry = dir + "/entry.ts";
await writeFile(
  entry,
  `${vocabulary ? "import hot from './hot.bin';import ids from './ids.bin';" : ""}import root from './source-root.json';import{createConstructionWorker}from'../../src/columnar/construction/worker.ts';export default createConstructionWorker(root as any,${JSON.stringify(code)}${vocabulary ? ",{..." + JSON.stringify(vocabulary) + ",hot:new Uint8Array(hot),ids:new Uint32Array(ids)}" : ""});`,
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
  rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
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
for (let attempt = 0; ; attempt++) {
  const response = await fetch(`https://${name}.phulin.workers.dev/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const health = response.ok ? ((await response.json()) as any) : undefined;
  if (health?.code === code) break;
  if (attempt >= 6)
    throw Error("Constructor has not activated the expected code");
  await new Promise((r) => setTimeout(r, Math.min(10000, 500 * 2 ** attempt)));
}
console.log(
  JSON.stringify({
    name,
    code,
    source: dir + "/source-root.json",
    placement: "aws:us-east-1",
    vocabulary: vocabulary
      ? {
          count: vocabulary.count,
          rootSha256: vocabulary.rootSha256,
          packets: vocabulary.packets.length,
        }
      : undefined,
  }),
);
