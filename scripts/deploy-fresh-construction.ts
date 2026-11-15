import { readFile, writeFile, mkdir, readdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { benchmarkToken } from "../bench/columnar/token.js";
const [name, sourcePath] = process.argv.slice(2);
if (!/^work-search-cws-fresh-[a-z0-9-]+$/.test(name ?? "") || !sourcePath)
  throw Error("Usage: deploy-fresh-construction.ts ISOLATED_NAME SOURCE_ROOT");
const dir = resolve("work/construction-v3/deploy/" + name);
await mkdir(dir, { recursive: true });
const source = await readFile(sourcePath),
  hash = createHash("sha256");
async function sources(path: string): Promise<void> {
  for (const d of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const file = path + "/" + d.name;
    if (d.isDirectory()) await sources(file);
    else hash.update(file).update(await readFile(file));
  }
}
await sources("src");
hash.update(source);
const code = hash.digest("hex"),
  token = await benchmarkToken();
const existing = await fetch(`https://${name}.phulin.workers.dev/health`, {
  headers: { authorization: `Bearer ${token}` },
}).catch(() => undefined);
if (existing?.ok) {
  const h = (await existing.json()) as any;
  if (h.code === code) {
    console.log(JSON.stringify({ name, code, reused: true }));
    process.exit(0);
  }
  throw Error(
    "Existing constructor has different code; choose a new isolated name",
  );
}
await writeFile(dir + "/source-root.json", source);
await mkdir(dir + "/source", { recursive: true });
await cp("src", dir + "/source/src", { recursive: true });
for (const file of ["package.json", "yarn.lock", "tsconfig.json"])
  await cp(file, dir + "/source/" + file);
await writeFile(
  dir + "/entry.ts",
  `import root from './source-root.json';import{createFreshConstructionWorker}from ${JSON.stringify(resolve("src/columnar/construction/fresh-worker.ts"))};export default createFreshConstructionWorker(root as any,${JSON.stringify(code)});`,
);
const config = {
  name,
  main: dir + "/entry.ts",
  account_id: "8f088d4bd190caf693cc42bb8311fd7d",
  compatibility_date: "2026-11-01",
  workers_dev: true,
  placement: { region: "aws:us-east-1" },
  r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
  limits: { cpu_ms: 300000 },
  observability: { enabled: true },
};
await writeFile(dir + "/wrangler.json", JSON.stringify(config, null, 2));
async function wrangler(args: string[], input?: string) {
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
await wrangler([
  "deploy",
  "--config",
  dir + "/wrangler.json",
  "--outdir",
  dir + "/dist",
]);
await wrangler(
  ["secret", "put", "INTERNAL_TOKEN", "--config", dir + "/wrangler.json"],
  token,
);
await writeFile(
  dir + "/manifest.json",
  JSON.stringify({
    name,
    code,
    sourcePath,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    at: new Date().toISOString(),
  }),
);
console.log(
  JSON.stringify({ name, code, url: `https://${name}.phulin.workers.dev` }),
);
