import { readFile, writeFile, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = process.env.FLP_ROOT ?? "bench/generated/flp-100000",
  prefix = process.env.FLP_PREFIX ?? "flp100k";
const builds = JSON.parse(
    await readFile(`bench/results/${prefix}-builds.json`, "utf8"),
  ),
  original = await readFile("data/bundle.bin"),
  rows = [];
try {
  for (const budget of [8, 16, 32, 48]) {
    if (
      builds.find((b: any) => b.budgetMiB === budget && b.policy === "mixed")
        ?.error
    ) {
      rows.push({ budgetMiB: budget, infeasible: true });
      continue;
    }
    await copyFile(`${root}/${budget}-mixed/bundle.bin`, "data/bundle.bin");
    const r = spawnSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--dry-run",
        "--outdir",
        `dist/${prefix}-${budget}`,
      ],
      { encoding: "utf8" },
    );
    const output = r.stdout + r.stderr;
    await writeFile(`bench/results/${prefix}-bundle-${budget}.txt`, output);
    if (r.status !== 0) throw Error(output);
    const upload = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(
      output,
    );
    rows.push({
      budgetMiB: budget,
      rawUploadKiB: upload ? Number(upload[1]) : undefined,
      gzipKiB: upload ? Number(upload[2]) : undefined,
    });
  }
  await writeFile(
    `bench/results/${prefix}-bundles.json`,
    JSON.stringify({ dryRun: true, rows }, null, 2),
  );
} finally {
  await writeFile("data/bundle.bin", original);
}
