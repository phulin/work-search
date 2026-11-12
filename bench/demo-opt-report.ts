import { readFile, writeFile } from "node:fs/promises";
const read = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const baseline = await read("bench/results/demo-realistic.json");
const stages = [
  { stage: 0, rows: baseline.local },
  ...(await Promise.all(
    [1, 2, 3].map(async (stage) => ({
      stage,
      rows: (await read(`bench/results/demo-opt-stage${stage}.json`)).rows,
    })),
  )),
];
const quantile = (a: number[], p: number) => {
  const sorted = [...a].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
};
const summary = [];
for (const s of stages)
  for (const mode of ["empirical-repeated", "empirical"])
    for (const phase of ["reset", "repeat"]) {
      const rows = s.rows.filter(
        (r: any) =>
          r.mode === mode &&
          r.phase === phase &&
          (phase === "reset" || r.pass === 2),
      );
      summary.push({
        stage: s.stage,
        mode,
        phase,
        n: rows.length,
        p50: quantile(
          rows.map((r: any) => r.ms),
          0.5,
        ),
        p95: quantile(
          rows.map((r: any) => r.ms),
          0.95,
        ),
        cpuP50: quantile(
          rows.map((r: any) => r.cpuMs),
          0.5,
        ),
        cpuP95: quantile(
          rows.map((r: any) => r.cpuMs),
          0.95,
        ),
        rssPeak: Math.max(...rows.map((r: any) => r.rss)),
        meanR2Reads:
          rows.reduce((n: number, r: any) => n + r.r2Requests, 0) / rows.length,
        zeroR2: rows.filter((r: any) => !r.r2Requests).length / rows.length,
      });
    }
const out = {
  kind: "Cumulative local simulation, measured R2 distributions, frozen 67 partitions; not deployed latency",
  documents: 2866398,
  bundleBudgetMiB: 8,
  note: "P95 of 16 scenarios is the maximum; CPU/RSS include all 67 logical Workers in one Node process.",
  summary,
};
await writeFile(
  "bench/results/demo-opt-summary.json",
  JSON.stringify(out, null, 2),
);
console.log("|Stage, final warmed pass|Repeated P50 / P95|Varied P50 / P95|");
console.log("|---|---:|---:|");
for (let stage = 0; stage < 4; stage++) {
  const a = summary.find(
      (s) =>
        s.stage === stage &&
        s.mode === "empirical-repeated" &&
        s.phase === "repeat",
    )!,
    b = summary.find(
      (s) =>
        s.stage === stage && s.mode === "empirical" && s.phase === "repeat",
    )!;
  console.log(
    `|${stage}|${(a.p50 / 1000).toFixed(2)}s / ${(a.p95 / 1000).toFixed(2)}s|${(b.p50 / 1000).toFixed(2)}s / ${(b.p95 / 1000).toFixed(2)}s|`,
  );
}
