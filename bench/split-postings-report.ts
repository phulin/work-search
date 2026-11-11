import { readFile, writeFile } from "node:fs/promises";
const after = JSON.parse(await readFile("bench/results/results.json", "utf8")),
  before = JSON.parse(
    await readFile("bench/baseline-v3-optimized/results/results.json", "utf8"),
  );
const mb = (n: number) => (n / 1048576).toFixed(2),
  rows: any[] = [];
const connector = (r: any) => {
  const good = r.connectorSamples.filter((s: any) => !s.error),
    lat = good.map((s: any) => s.ms).sort((a: number, b: number) => a - b),
    mean = (k: string) =>
      good.reduce((s: number, x: any) => s + (x[k] ?? 0), 0) / good.length;
  return {
    p50Ms: lat[Math.ceil(lat.length * 0.5) - 1] ?? NaN,
    p95Ms: lat[Math.ceil(lat.length * 0.95) - 1] ?? NaN,
    avgRequests: mean("indexRequests"),
    avgBytes: mean("indexBytes"),
    frequencyRequests: mean("frequencyRequests"),
    positionRequests: mean("positionRequests"),
    positionBytes: mean("positionBytes"),
    zeroReadPercent:
      (100 * good.filter((s: any) => s.fullyLocal).length) / good.length,
    failures: r.connectorSamples.length - good.length,
  };
};
let report =
  "# Split frequency and position postings (v3 → v4)\n\nFormat v4 independently encodes and locates document IDs/term frequencies and field positions. The Worker dictionary contains complete descriptors for both streams; no remote dictionary lookup is added. Plain terms and Boolean expressions fetch and decode **frequency bytes only**, with zero positional range reads, zero position CRC traversal, and no positional offsets allocated. Phrase/proximity expressions fetch positions only for location-dependent terms. Frequency and position jobs share the same concurrency-four queue, so streams can arrive in parallel. Exact matching, ranking and query syntax are unchanged.\n\nThe previous optimized v3 results are preserved in baseline-v3-optimized/. This run rebuilds the same corpora (10k/100k/1m, seed 42), all four unchanged budgets and both policies. The twelve plain queries and seven separate connector queries use three passes each, top 20, IDs only. Workload-aware embedding is trained on the plain-term workload, so plain-query local-hit rates are optimistic. All measurements are local Node HTTP handler/filesystem, not deployed Cloudflare latency. Peak process RSS includes indexing only in fresh-build runs; inherited construction figures in reuse runs are labeled in raw results.\n\n## Plain-term queries\n\nColumns show **v3 → v4**. Each v4 plain query is checked to have zero positional requests/bytes. Frequencies get embedding priority; positions are eligible for remaining space only when their frequency stream is embedded. Both smallest-first and workload selection are applied independently within each tier. This policy favors plain-term local hit rates and does not attempt a globally optimal mixed-workload allocation.\n\n|Docs|Budget MiB|Policy|Frequency MiB|Position MiB|Dictionary MiB|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Build s|Failures|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
for (const a of after.results) {
  const b = before.results.find(
    (r: any) =>
      r.documents === a.documents &&
      r.budgetMiB === a.budgetMiB &&
      r.strategy === a.strategy,
  );
  if (a.status !== "ok") {
    report += `|${a.documents}|${a.budgetMiB}|${a.strategy}|FAILED ${a.error}||||||||||\n`;
    continue;
  }
  for (const s of a.samples)
    if (!s.error && (s.positionRequests !== 0 || s.positionBytes !== 0))
      throw new Error("Plain query read positions");
  const pair = (k: string, f = (n: number) => n.toFixed(2)) =>
    `${b?.status === "ok" ? f(b[k]) : "n/a"} → ${f(a[k])}`;
  report += `|${a.documents}|${a.budgetMiB}|${a.strategy}|${mb(a.frequencyBytes)}|${mb(a.positionBytes)}|${mb(a.dictionaryBytes)}|${pair("zeroReadPercent", (n) => n.toFixed(1))}|${pair("avgRequests")}|${pair("avgBytes", (n) => n.toFixed(0))}|${pair("p50Ms")}|${pair("p95Ms")}|${pair("avgCpuMs")}|${pair("buildMs", (n) => (n / 1000).toFixed(2))}|${a.samples.filter((s: any) => s.error).length}|\n`;
  const current = connector(a),
    old = b?.status === "ok" ? connector(b) : null;
  rows.push({
    documents: a.documents,
    budgetMiB: a.budgetMiB,
    strategy: a.strategy,
    before: old,
    after: current,
  });
}
report +=
  "\n## Connector-query tradeoff\n\nSplitting can add a position-range request to a term that previously needed one combined range. Frequency-first embedding can leave positions remote even when all frequencies are bundled. Transfers are smaller per stream, but query-local hit rates and remote request counts can worsen for positional workloads. These costs are reported rather than hidden. API diagnostics separate frequency and position requests/bytes; index totals remain their sum, excluding optional metadata.\n\n|Docs|Budget MiB|Policy|Zero reads % v3 → v4|Reads/query v3 → v4|Bytes/query v3 → v4|P95 ms v3 → v4|v4 position reads/query|v4 failures|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|\n";
for (const r of rows) {
  const a = r.after,
    b = r.before,
    pair = (k: string, d = 2) =>
      `${b ? b[k].toFixed(d) : "n/a"} → ${a[k].toFixed(d)}`;
  report += `|${r.documents}|${r.budgetMiB}|${r.strategy}|${pair("zeroReadPercent", 1)}|${pair("avgRequests")}|${pair("avgBytes", 0)}|${pair("p95Ms")}|${a.positionRequests.toFixed(2)}|${a.failures}|\n`;
}
report +=
  "\n## Correctness and migration\n\nUnit/integration tests cover plain Boolean queries with positional storage disabled, independently embedded frequency/position combinations, selective positional terms, stream CRCs and cross-stream binding, corrupt positional descriptors, Unicode, phrases, proximity and exact BM25 results across budgets. The positional stream stores the CRC32 of its corresponding frequency bytes; generation-scoped keys and both dictionary CRCs are still verified. CRCs are integrity checks, not authentication against a malicious writer.\n\nA complete v4 generation is required: rebuild indexes and deploy the matching v4 Worker. The 40-byte term descriptor adds 12 bytes per vocabulary term; the compact document-table format remains DTC2. Streams are packed into separate immutable frequencies-N.bin and positions-N.bin objects, with independent local/remote offsets and byte ranges. No per-term tiny objects are created. Old v3 indexes cannot be served by the v4 reader.\n\nRaw samples are in results/results.json and the individual configuration JSON files, including all frequency/position diagnostics and failures. Actual local workerd measurements are in WORKERD.md. This small synthetic workload gives limited tail-latency confidence; no Cloudflare deployment or production-network measurements are claimed.\n";
try {
  const paired = JSON.parse(
    await readFile("bench/results/paired-split.json", "utf8"),
  );
  report +=
    "\n## Paired cross-format validation\n\nThe preserved v3 builds and new v4 builds contain identical ordered documents. One warmup and three alternating-order measured passes compare full API result IDs/scores and exact total counts for every plain and connector query. Index layout and embedding policy both change, so I/O is reported rather than required to be identical. The same-process comparison reduces between-run scheduling noise but remains local filesystem/search execution, not deployed Cloudflare latency.\n\n|Configuration|Suite|v3 P95 ms|v4 P95 ms|v3 reads/query|v4 reads/query|v3 bytes/query|v4 bytes/query|\n|---|---|---:|---:|---:|---:|---:|---:|\n";
  for (const row of paired.rows)
    for (const kind of ["plain", "connectors"]) {
      const samples = row.samples.filter((x: any) => x.kind === kind),
        p = (key: string) =>
          samples.map((x: any) => x[key]).sort((a: number, b: number) => a - b)[
            Math.ceil(samples.length * 0.95) - 1
          ],
        mean = (key: string) =>
          samples.reduce((s: number, x: any) => s + x[key], 0) / samples.length;
      report += `|${row.name}|${kind}|${p("beforeMs").toFixed(2)}|${p("afterMs").toFixed(2)}|${mean("beforeRequests").toFixed(2)}|${mean("afterRequests").toFixed(2)}|${mean("beforeBytes").toFixed(0)}|${mean("afterBytes").toFixed(0)}|\n`;
    }
  report +=
    "\nRaw pairs are in results/paired-split.json. To reproduce, retain v3 builds from commit 64302c5 at bench/generated/v3-100000-8-workload and bench/generated/v3-1000000-48-workload, using the same generated corpora and query workload. Build the matching v4 configurations, then run `node --import tsx bench/paired-split.ts` and `node --import tsx bench/split-postings-report.ts`. V3 source and index-reader snapshots are preserved in baseline-v3-optimized/.\n";
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await writeFile("bench/SPLIT-POSTINGS.md", report);
await writeFile(
  "bench/results/split-postings.json",
  JSON.stringify({ environment: after.environment, rows }, null, 2),
);
