import { readFile, writeFile } from "node:fs/promises";
const before = JSON.parse(
  await readFile("bench/baseline-v1/results/results.json", "utf8"),
);
const after = JSON.parse(await readFile("bench/results/results.json", "utf8"));
const key = (r: any) => `${r.documents}-${r.budgetMiB}-${r.strategy}`;
const baseline = new Map(before.results.map((r: any) => [key(r), r]));
const mb = (n: number) => (n / 1048576).toFixed(2);
const comparison = after.results.map((r: any) => {
  const old = baseline.get(key(r)) as any;
  return {
    documents: r.documents,
    budgetMiB: r.budgetMiB,
    strategy: r.strategy,
    before: old ?? null,
    after: r,
  };
});
let report =
  "# Document-table compression: v1 → v2\n\nThe v1 baseline and complete raw results are preserved in baseline-v1/. Both runs use the same Apple M3 host, deterministic corpus seed 42, twelve queries, three passes each, and budget/selection matrix. Measurements were collected in separate runs, not interleaved: timing changes include runtime noise, host load, and memory/GC effects. They are local Node HTTP-handler/filesystem results, not Cloudflare latency. No artificial network delay is applied. Workload-aware selection is trained on the benchmark queries and therefore optimistic.\n\n## Table size\n\n|Documents|v1 table MiB|v2 table MiB|Reduction|Mandatory dictionary + table MiB|\n|---:|---:|---:|---:|---:|\n";
for (const n of [...new Set(after.results.map((r: any) => r.documents))]) {
  const r = after.results.find(
    (r: any) => r.documents === n && r.status === "ok",
  );
  if (!r) continue;
  report += `|${n}|${mb(r.documentTableUncompressedBytes)}|${mb(r.documentTableBytes)}|${(100 * (1 - r.documentTableBytes / r.documentTableUncompressedBytes)).toFixed(1)}%|${mb(r.dictionaryBytes + r.documentTableBytes)}|\n`;
}
report +=
  "\nThe million-document v1 mandatory tables consumed 33.02 MiB and rejected 8, 16, and 32 MiB budgets. Format v2 fits all four budgets without paging IDs or lengths to R2. Lengths use block minima plus bit-packed deltas; IDs use UTF-8 prefix sharing; metadata uses contiguous pointers with explicit exceptions. Scoring accesses lengths directly, while winner ID decoding scans at most 32 records. Per-block CRC validation is lazy and uses a one-bit-per-block bitmap (3,907 bytes for one million documents). There is no full-table expansion at startup. Compression depends on ID/length/pointer distributions; arbitrary corpora need not achieve this ratio.\n\n## Full matrix\n\nColumns show **v1 → v2**. “Infeasible” means the old mandatory data exceeded the bundle budget. P50/P95 timings are milliseconds. RSS is offline build+query process peak, not Worker isolate memory.\n\n|Docs|Budget MiB|Policy|Bundle MiB|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Build s|Peak RSS MiB|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
for (const { before: b, after: a } of comparison) {
  if (a.status !== "ok") {
    report += `|${a.documents}|${a.budgetMiB}|${a.strategy}|failed: ${a.error}|||||||||\n`;
    continue;
  }
  const pair = (
    field: string,
    fmt: (v: number) => string = (v) => v.toFixed(2),
  ) =>
    `${b?.status === "ok" ? fmt(b[field]) : "infeasible"} → ${fmt(a[field])}`;
  report += `|${a.documents}|${a.budgetMiB}|${a.strategy}|${pair("bundleBytes", mb)}|${pair("zeroReadPercent", (v) => v.toFixed(1))}|${pair("avgRequests")}|${pair("avgBytes", (v) => v.toFixed(0))}|${pair("p50Ms")}|${pair("p95Ms")}|${pair("avgCpuMs")}|${pair("buildMs", (v) => (v / 1000).toFixed(2))}|${pair("queryPeakRssBytes", mb)}|\n`;
}
const failed = after.results
  .flatMap((r: any) => r.samples ?? [])
  .filter((s: any) => s.error).length;
report += `\nMeasured query failures: ${failed}. Full per-query data and totals remain in results/results.json. The baseline format is 1; the new format is 2. A complete rebuild is required, and generations include the format version. Old bundles are deliberately rejected rather than interpreted using the new layout.\n\n## Interpretation\n\nSmaller mandatory tables create space for more postings at the same budget. The effect on read counts depends on the selection policy and query workload; smaller tables do not guarantee every query becomes local. Exhaustive scoring of very common terms remains the CPU bottleneck. Compression adds per-block header/bit decoding and one-time block checksums; use the measured CPU and tail latency rather than assuming that fewer bytes always means faster queries. Direct length reads preserve bounded memory and avoid decoding IDs for non-winning candidates.\n\nSee WORKERD.md for actual local Worker HTTP/startup measurements, RESOURCES.md for storage/cost estimates, and results/bundle-dry-run.txt for the largest deployment artifact. No Cloudflare deployment was performed.\n`;
await writeFile("bench/COMPARISON.md", report);
await writeFile(
  "bench/results/comparison.json",
  JSON.stringify(
    {
      baselineEnvironment: before.environment,
      currentEnvironment: after.environment,
      comparison,
    },
    null,
    2,
  ),
);
