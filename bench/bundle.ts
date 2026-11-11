import { readFile, writeFile, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const selected =
    process.argv[2] ?? "bench/generated/1000000-48-workload/bundle.bin",
  original = await readFile("data/bundle.bin");
try {
  await copyFile(selected, "data/bundle.bin");
  const r = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--outdir",
      "dist/large",
    ],
    { encoding: "utf8" },
  );
  await writeFile("bench/results/bundle-dry-run.txt", r.stdout + r.stderr);
  console.log(r.stdout + r.stderr);
  if (r.status !== 0) throw new Error("Bundle dry run failed");
} finally {
  await writeFile("data/bundle.bin", original);
}
