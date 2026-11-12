import { readFile, writeFile } from "node:fs/promises";
const root = "work/demo-bench";
const percentile = (a: number[], p: number) =>
  [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1];
const summary = (rows: any[]) => ({
  n: rows.length,
  p50: percentile(
    rows.map((r) => r.ms),
    0.5,
  ),
  p95: percentile(
    rows.map((r) => r.ms),
    0.95,
  ),
  meanReads: rows.reduce((n, r) => n + r.r2Requests, 0) / rows.length,
  meanBytes: rows.reduce((n, r) => n + r.r2Bytes, 0) / rows.length,
  cpuP50: percentile(
    rows.map((r) => r.cpuMs ?? 0),
    0.5,
  ),
  peakRss: Math.max(...rows.map((r) => r.rss ?? 0)),
});
const compact = (r: any) => {
  const events = r.trace.events;
  return {
    ...Object.fromEntries(
      [
        "q",
        "kind",
        "mode",
        "phase",
        "pass",
        "ms",
        "clientMs",
        "cpuMs",
        "rss",
      ].map((k) => [k, r[k]]),
    ),
    r2Requests: events.filter((e: any) => e.type === "r2").length,
    r2Bytes: events.reduce(
      (n: number, e: any) => n + (e.type === "r2" ? (e.bytes ?? 0) : 0),
      0,
    ),
    statsCalls: events.filter((e: any) => e.type === "service" && e.payload?.df)
      .length,
    results: r.results,
  };
};
const local: any[] = [];
for (const level of [3, 4, 5]) {
  const run = JSON.parse(
    await readFile(root + `/next-stage${level}.json`, "utf8"),
  );
  if (!run.complete) throw Error("Incomplete stage " + level);
  local.push(...run.rows.map((r: any) => ({ level, ...compact(r) })));
}
const native = JSON.parse(await readFile(root + "/next-native.json", "utf8"));
if (native.rows.length !== 288) throw Error("Native matrix incomplete");
const live = native.rows.map((r: any) => ({ level: r.level, ...compact(r) }));
const result = {
  corpus: { documents: 2866398, partitions: 67, leafBudgetMiB: 8 },
  method:
    "Local empirical R2 simulation and separate interleaved native 6-pass trial; 16 scenarios, P95 is maximum; same leaves may share caches; passage fixtures cover benchmark result documents only",
  local,
  native: live,
  summary: {
    local: [3, 4, 5].flatMap((level) =>
      ["empirical-repeated", "empirical"].flatMap((mode) =>
        ["reset", "repeat"].map((phase) => ({
          level,
          mode,
          phase,
          ...summary(
            local.filter(
              (r) =>
                r.level === level &&
                r.mode === mode &&
                r.phase === phase &&
                (phase === "reset" || r.pass === 2),
            ),
          ),
        })),
      ),
    ),
    native: [3, 4, 5].flatMap((level) =>
      [0, 1, 2, 3, 4, 5].map((pass) => ({
        level,
        pass,
        ...summary(
          live.filter((r: any) => r.level === level && r.pass === pass),
        ),
      })),
    ),
  },
};
await writeFile(
  "bench/results/demo-next.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result.summary, null, 2));
