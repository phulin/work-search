import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const rows = [];
for (const budget of [8, 16, 32, 48])
  for (const policy of ["frequency", "mixed"]) {
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
    const file = `boolean-wand-final-${budget}-${policy}.json`;
    const result = JSON.parse(await readFile("bench/results/" + file, "utf8"));
    rows.push({
      budgetMiB: budget,
      policy,
      file,
      queries: result.samples.length,
      errors: result.samples.filter((s: any) => s.error).length,
    });
    await writeFile(
      "bench/results/boolean-final.json",
      JSON.stringify({ local: true, rows }, null, 2),
    );
  }
