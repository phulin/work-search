import { readFile, writeFile } from "node:fs/promises";
const current = JSON.parse(
  await readFile("bench/results/results.json", "utf8"),
);
const previous = JSON.parse(
  await readFile("bench/baseline-v2-optimized/results/results.json", "utf8"),
);
const mb = (n: number) => (n / 1048576).toFixed(2),
  rows = [];
let report =
  "# Positional terms-and-connectors benchmark\n\nFormat v3 stores body/title token positions in every posting. The compressed document table is unchanged. All 24 configurations use the same seed-42 corpora, budgets, and embedding policies as the optimized v2 baseline preserved in baseline-v2-optimized/. Baseline plain-term queries still use the same twelve queries × three passes; seven separate connector queries × three passes are **not** included in the embedding-policy training workload. Workload-aware plain-term results remain optimistic.\n\nMeasurements are local Node HTTP-handler/filesystem ranges with warm OS caches, not deployed Cloudflare latency. CPU is process CPU. In --reuse-indexes runs, construction timings/RSS are inherited baseline figures; query timings and query-process RSS are new, and exclude the offline builder. Reused objects and bundle hashes are verified before queries. Positional checks decode only candidate-document positions, with no corpus-wide map of match spans. Early resource-limit failures are preserved as failures rather than counted as zero matches.\n\n## Plain-term comparison (v2 → v3)\n\n|Docs|Budget MiB|Policy|Postings MiB|Bundle MiB|Zero index reads %|Reads/query|P95 ms|Build seconds|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|\n";
for (const r of current.results) {
  const b = previous.results.find(
    (x: any) =>
      x.documents === r.documents &&
      x.budgetMiB === r.budgetMiB &&
      x.strategy === r.strategy,
  );
  if (r.status !== "ok") {
    report += `|${r.documents}|${r.budgetMiB}|${r.strategy}|FAILED: ${r.error}||||||\n`;
    continue;
  }
  const pair = (key: string, f = (n: number) => n.toFixed(2)) =>
    `${b?.status === "ok" ? f(b[key]) : "n/a"} → ${f(r[key])}`;
  report += `|${r.documents}|${r.budgetMiB}|${r.strategy}|${pair("postingsBytes", mb)}|${pair("bundleBytes", mb)}|${pair("zeroReadPercent", (n) => n.toFixed(1))}|${pair("avgRequests")}|${pair("p95Ms")}|${pair("buildMs", (n) => (n / 1000).toFixed(2))}|\n`;
  const good = r.connectorSamples.filter((s: any) => !s.error),
    times = good.map((s: any) => s.ms).sort((a: number, b: number) => a - b),
    mean = (key: string) =>
      good.reduce((s: number, x: any) => s + x[key], 0) / good.length;
  rows.push({
    documents: r.documents,
    budgetMiB: r.budgetMiB,
    strategy: r.strategy,
    queries: r.connectorSamples.length,
    failures: r.connectorSamples.length - good.length,
    zeroReadPercent:
      (100 * good.filter((s: any) => s.fullyLocal).length) / good.length,
    avgRequests: mean("indexRequests"),
    avgBytes: mean("indexBytes"),
    avgCpuMs: mean("cpuMs"),
    p50Ms: times[Math.ceil(times.length * 0.5) - 1] ?? NaN,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? NaN,
  });
}
report +=
  "\n## Connector suite\n\n|Docs|Budget MiB|Policy|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Failures|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|\n";
for (const r of rows)
  report += `|${r.documents}|${r.budgetMiB}|${r.strategy}|${r.zeroReadPercent.toFixed(1)}|${r.avgRequests.toFixed(2)}|${r.avgBytes.toFixed(0)}|${r.p50Ms.toFixed(2)}|${r.p95Ms.toFixed(2)}|${r.avgCpuMs.toFixed(2)}|${r.failures}|\n`;
report +=
  "\nConnector queries include an exact common phrase, common-term /s, category/word /p, grouped OR with AND, phrase exclusion, a rare phrase, and grouped proximity. They measure correctness-oriented exhaustive evaluation, not a proprietary Lexis implementation. Common phrases can examine one million candidates and are substantially more CPU-intensive than term-only search. Typed-array offsets are allocated only for positional queries; individual candidate positions are decoded on demand. The fixed workload is small, so tail percentiles have limited confidence. Metadata is not requested.\n\nRaw per-query totals, errors, I/O, CPU and timings are in results/results.json and individual configuration JSONs. Actual local workerd HTTP results are in WORKERD.md. No Cloudflare deployment or network measurements were performed. See docs/QUERY.md for exact supported syntax, precedence, matching rules and safeguards.\n";
await writeFile("bench/CONNECTORS.md", report);
await writeFile(
  "bench/results/connectors.json",
  JSON.stringify({ environment: current.environment, rows }, null, 2),
);
