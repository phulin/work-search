import { readFile, writeFile } from "node:fs/promises";
const paths = process.argv.slice(2);
const summary = [];
for (const path of paths) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const groups = new Map<string, any[]>();
  for (const row of data.rows) {
    const key = JSON.stringify([
      row.name ?? row.mode,
      row.pass ?? null,
      row.group,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  for (const [key, rows] of groups) {
    const [variant, pass, group] = JSON.parse(key);
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const ds = rows.map((r) => r.diagnostics ?? r);
    const mean = (values: number[]) =>
      values.reduce((s, n) => s + n, 0) / values.length;
    summary.push({
      file: path,
      budgetMiB: data.budgetMiB,
      variant,
      pass,
      group,
      queries: rows.length,
      p50Ms: times[Math.ceil(times.length * 0.5) - 1],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      zeroR2Percent:
        (100 * ds.filter((d) => d.requests === 0).length) / rows.length,
      meanRequests: mean(ds.map((d) => d.requests)),
      meanMiB: mean(ds.map((d) => d.bytes / 1048576)),
      meanCpuMs: rows.every((r) => r.cpuMs !== undefined)
        ? mean(rows.map((r) => r.cpuMs))
        : undefined,
      maxProcessPeakRssMiB: rows.some((r) => r.processPeakRssMiB)
        ? Math.max(...rows.map((r) => r.processPeakRssMiB))
        : undefined,
    });
  }
}
console.log(JSON.stringify(summary, null, 2));
if (process.env.GLOBAL_SUMMARY)
  await writeFile(process.env.GLOBAL_SUMMARY, JSON.stringify(summary, null, 2));
