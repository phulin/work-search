import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const results: any[] = [];
function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    encoding: "utf8",
    maxBuffer: 1048576,
  });
  if (r.status !== 0) throw Error(r.stderr || r.stdout);
  return r.stdout;
}
for (const n of [10000, 100000, 1000000]) {
  const prefix = n === 1000000 ? "next" : `next-${n}`;
  if (n !== 1000000)
    run([
      "bench/repack.ts",
      `bench/generated/${n}-8-workload`,
      `bench/generated/${prefix}-7r-8`,
      "8388608",
      "frequency",
      "bench/generated/queries.txt",
      "7",
    ]);
  for (const policy of ["frequency", "mixed"]) {
    for (const budget of [8, 16, 32, 48]) {
      const base = `bench/generated/${prefix}-7r-8`,
        out = `bench/generated/matrix-${n}-${budget}-${policy}`;
      if (base !== out)
        run([
          "bench/repack.ts",
          base,
          out,
          String(budget * 1048576),
          policy,
          "bench/generated/mixed-training.txt",
        ]);
    }
    run(["bench/next.ts", "7", String(n), policy, "matrix"]);
    results.push(
      JSON.parse(
        await readFile(
          `bench/results/next-7${n === 1000000 ? "" : `-${n}`}${policy === "mixed" ? "-mixed" : ""}-matrix.json`,
          "utf8",
        ),
      ),
    );
    console.log(`${n} ${policy} done`);
  }
}
await writeFile(
  "bench/results/next-matrix.json",
  JSON.stringify({ local: true, results }, null, 2),
);
