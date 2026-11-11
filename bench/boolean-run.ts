import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const rows: any[] = [];
const resultStem = process.env.FLP_PREFIX
  ? `${process.env.FLP_PREFIX}-boolean`
  : "boolean";
const builds = process.env.FLP_PREFIX
  ? JSON.parse(
      await readFile(
        `bench/results/${process.env.FLP_PREFIX}-builds.json`,
        "utf8",
      ),
    )
  : undefined;
for (const budget of [8, 16, 32, 48])
  for (const policy of ["frequency", "mixed"]) {
    const failed = builds?.find(
      (b: any) => b.budgetMiB === budget && b.policy === policy && b.error,
    );
    if (failed) {
      rows.push({ budgetMiB: budget, policy, infeasible: failed.error });
      continue;
    }
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/boolean-task.ts",
        String(budget),
        policy,
        "wand-final",
      ],
      { encoding: "utf8", maxBuffer: 1048576 },
    );
    if (r.status !== 0) throw Error(r.stderr || r.stdout);
    console.log(r.stdout.trim());
    const file = `${resultStem}-wand-final-${budget}-${policy}.json`;
    const result = JSON.parse(await readFile("bench/results/" + file, "utf8"));
    rows.push({
      budgetMiB: budget,
      policy,
      file,
      queries: result.samples.length,
      errors: result.samples.filter((s: any) => s.error).length,
    });
    await writeFile(
      `bench/results/${resultStem}-final.json`,
      JSON.stringify({ local: true, rows }, null, 2),
    );
  }

await writeFile(
  `bench/results/${resultStem}-final.json`,
  JSON.stringify({ local: true, rows }, null, 2),
);
