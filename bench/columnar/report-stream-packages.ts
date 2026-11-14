/** Summarize randomized complete-response experiments without pooling workloads. */
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const [input, output] = process.argv.slice(2);
if (!output)
  throw Error("Usage: report-stream-packages.ts INPUT.json.gz OUTPUT.json");
const data = JSON.parse(gunzipSync(await readFile(input)).toString());
const distribution = (values: number[]) => {
  const a = [...values].sort((a, b) => a - b),
    n = a.length;
  return {
    n,
    min: a[0],
    median: n % 2 ? a[n >>> 1] : (a[n / 2 - 1] + a[n / 2]) / 2,
    max: a.at(-1),
  };
};
const measurements = {
  latencyMs: (r: any) => r.wallMs,
  processCpuMs: (r: any) => r.cpuMs ?? r.localProcessCpuMs,
  originGets: (r: any) => (r.io ?? r.modeledIO).r2,
  sharedGets: (r: any) => (r.io ?? r.modeledIO).sharedGet,
  transferredBytes: (r: any) => {
    const io = r.io ?? r.modeledIO;
    return io.r2Bytes + io.sharedGetBytes;
  },
  scorePostings: (r: any) => r.diagnostics.scorePostingsDecoded,
  postings: (r: any) => r.diagnostics.postings,
  positionIntegers: (r: any) => r.diagnostics.positionIntegers,
  forwardIntegers: (r: any) => r.diagnostics.forwardIntegers,
  pairMembershipIntegers: (r: any) => r.diagnostics.pairMembershipIntegers,
  pairContextIntegers: (r: any) => r.diagnostics.pairContextIntegers,
  commonPresenceIntegers: (r: any) => r.diagnostics.commonPresenceIntegers,
  decodedBytes: (r: any) => r.diagnostics.decodedBytes,
  repeatedDecodedBytes: (r: any) => r.diagnostics.repeatedDecodedBytes,
  inflatedBytes: (r: any) => r.diagnostics.inflatedBytes,
  repeatedInflatedBytes: (r: any) => r.diagnostics.repeatedInflatedBytes,
  scoreBlocks: (r: any) => r.diagnostics.scoreBlocksFetched,
  scoreIOWaves: (r: any) => r.diagnostics.scoreIOWaves,
  positionIOWaves: (r: any) => r.diagnostics.positionIOWaves,
  anchorIOWaves: (r: any) => r.diagnostics.anchorIOWaves,
  packageIOWaves: (r: any) => r.diagnostics.packageIOWaves,
  packageMetadataWaves: (r: any) => r.diagnostics.packageMetadataFetchWaves,
  dataIOWaves: (r: any) =>
    r.diagnostics.scoreIOWaves +
    (r.diagnostics.positionIOWaves ?? 0) +
    (r.diagnostics.anchorIOWaves ?? 0) +
    (r.diagnostics.packageIOWaves ?? 0),
  packageBytes: (r: any) => r.diagnostics.candidatePackageBytes,
  packageCandidates: (r: any) => r.diagnostics.packageCandidates,
  peakActiveBufferBytes: (r: any) => r.diagnostics.peakActiveBufferBytes,
  peakBatchBytes: (r: any) => r.diagnostics.peakPackageBatchBytes,
  peakWinnerBytes: (r: any) => r.diagnostics.peakWinnerPackageBytes,
  retainedPageBytes: (r: any) => r.diagnostics.retainedPageBytes,
  retainedDecodedBytes: (r: any) => r.diagnostics.retainedDecodedBytes,
  resultOriginGets: (r: any) => r.diagnostics.resultRequests,
  resultSharedGets: (r: any) => r.diagnostics.resultSharedGets,
  resultMs: (r: any) => r.diagnostics.metadataMs,
};
const groups = new Map<string, any[]>();
for (const row of data.rows) {
  if (row.error || row.unsupported) throw Error(JSON.stringify(row));
  const key = JSON.stringify([
    row.q,
    row.variant ?? row.plan,
    row.condition ?? data.manifest.condition,
  ]);
  const group = groups.get(key) ?? [];
  group.push(row);
  groups.set(key, group);
}
const rows = [...groups].map(([key, rs]) => {
  const [q, variant, condition] = JSON.parse(key);
  return {
    q,
    variant,
    condition,
    n: rs.length,
    metrics: Object.fromEntries(
      Object.entries(measurements).flatMap(([key, fn]) => {
        const values = rs.map(fn);
        return values.every((v) => typeof v === "number" && Number.isFinite(v))
          ? [[key, distribution(values)]]
          : [];
      }),
    ),
    plan: rs[0].diagnostics.plan,
    candidates: rs[0].candidateInput,
  };
});
await writeFile(
  output,
  JSON.stringify(
    {
      input,
      manifest: data.manifest,
      notes:
        "Per-query medians and ranges; diagnostic sample sizes do not establish P99. CPU is process usage during simulated waits, not isolated CPU. Data waves exclude hierarchy/directory discovery and result rendering; memory is accounted buffers, not heap.",
      rows,
    },
    null,
    2,
  ),
);
for (const r of rows)
  console.log(
    r.q,
    r.variant,
    r.condition,
    Math.round(r.metrics.latencyMs.median),
    "ms",
    (r.metrics.transferredBytes.median / 1048576).toFixed(2),
    "MiB",
  );
