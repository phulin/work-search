import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { connectorQueries } from "./connector-queries.js";
const plain = (await readFile("bench/generated/queries.txt", "utf8"))
  .split("\n")
  .filter(Boolean);
await writeFile(
  "bench/generated/mixed-training.txt",
  [...plain, ...connectorQueries].join("\n"),
);
await mkdir("bench/results", { recursive: true });
const builds: any[] = [],
  results: any[] = [];
const sizes = (process.argv[2] ?? "10000,100000,1000000")
    .split(",")
    .map(Number),
  budgets = (process.argv[3] ?? "8,16,32,48").split(",").map(Number);
for (const n of sizes)
  for (const budget of budgets) {
    const name = `${n}-${budget}`;
    for (const policy of ["frequency", "mixed"]) {
      const out = `bench/generated/remaining-${name}-${policy}`;
      await rm(out, { recursive: true, force: true });
      const r = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "bench/repack.ts",
          `bench/generated/${name}-workload`,
          out,
          String(budget * 1048576),
          policy,
          "bench/generated/mixed-training.txt",
        ],
        { encoding: "utf8", maxBuffer: 1048576 },
      );
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      builds.push({ name, ...JSON.parse(r.stdout) });
    }
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "bench/remaining-task.ts", String(n), String(budget)],
      { encoding: "utf8", maxBuffer: 1048576 },
    );
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    console.log(r.stdout.trim());
    results.push(
      JSON.parse(
        await readFile(`bench/results/remaining-${name}.json`, "utf8"),
      ),
    );
    await writeFile(
      "bench/results/remaining.json",
      JSON.stringify(
        {
          kind: "Four optimization ablations, separate query processes; repacked identical encoded postings, same training workload for policies; local only",
          date: new Date().toISOString(),
          training: [...plain, ...connectorQueries],
          builds,
          results,
        },
        null,
        2,
      ),
    );
  }
