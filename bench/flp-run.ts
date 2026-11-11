import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const results: any[] = [];
const builds = JSON.parse(
  await readFile("bench/results/flp-builds.json", "utf8"),
);
for (const budget of [8, 16, 32, 48])
  for (const policy of ["frequency", "mixed"]) {
    const build = builds.find(
      (b: any) => b.budgetMiB === budget && b.policy === policy,
    );
    if (build?.error) {
      results.push({ budget, policy, infeasible: build.error });
      continue;
    }
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "bench/flp-task.ts", String(budget), policy],
      { encoding: "utf8", maxBuffer: 1048576 },
    );
    if (r.status !== 0) throw Error(r.stderr || r.stdout);
    console.log(r.stdout.trim());
    results.push(
      JSON.parse(
        await readFile(`bench/results/flp-${budget}-${policy}.json`, "utf8"),
      ),
    );
    await writeFile(
      "bench/results/flp-matrix.json",
      JSON.stringify({ local: true, results }, null, 2),
    );
  }
