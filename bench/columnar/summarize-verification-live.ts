import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const [responses, native, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "Usage: summarize-verification-live.ts RESPONSES.gz NATIVE.gz OUTPUT.json",
  );
const read = async (path: string) =>
    JSON.parse(gunzipSync(await readFile(path)).toString()),
  [data, tails] = await Promise.all([read(responses), read(native)]),
  cpu = new Map(
    tails.rows
      .filter((r: any) => r.requestId)
      .map((r: any) => [r.requestId, r]),
  ) as Map<string, any>;
const distribution = (values: number[]) => {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b),
    n = a.length;
  if (!n) return { n };
  return {
    n,
    min: a[0],
    p50: n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2,
    p95: a[Math.min(n - 1, Math.ceil(n * 0.95) - 1)],
    p99: a[Math.min(n - 1, Math.ceil(n * 0.99) - 1)],
    max: a[n - 1],
  };
};
const fields = [
  "requests",
  "bytes",
  "sharedGets",
  "sharedPuts",
  "memoryHits",
  "sharedBudgetBypasses",
  "scoreBlocksFetched",
  "scorePostingsDecoded",
  "positionIntegers",
  "wordPositionIntegers",
  "wordPositionBlocks",
  "wordPositionBytes",
  "exactPhraseReads",
  "exactPhraseDiscoveryReads",
  "exactPhraseDiscoveryBytes",
  "exactPhraseDiscoveryWaves",
  "exactPhraseBytes",
  "exactPhraseOccurrences",
  "exactPhraseMatches",
  "peakExactPhraseBufferBytes",
  "forwardIntegers",
  "pairPositionBytes",
  "pairPositionChunks",
  "scoreIOWaves",
  "positionIOWaves",
  "stages",
  "packagePipelineLoads",
  "packagePipelineWaits",
  "peakPackagePipelinePending",
  "packageCandidates",
  "packageMatches",
  "candidatePackageBytes",
  "documentVerificationBytes",
  "documentPresentationBytes",
  "metadataMs",
  "resultRequests",
  "resultBytes",
  "retainedPageBytes",
  "retainedDecodedBytes",
  "peakActiveBufferBytes",
  "decodedBytes",
  "repeatedDecodedBytes",
  "inflatedBytes",
  "repeatedInflatedBytes",
  "queueMs",
];
function stats(rows: any[]) {
  return {
    attempts: rows.length,
    correct: rows.filter((r) => r.correct).length,
    errors: rows
      .filter((r) => !r.correct)
      .map((r) => ({
        requestId: r.requestId,
        status: r.status,
        error: r.error ?? r.result?.error,
        nativeOutcome: cpu.get(r.requestId)?.outcome,
      })),
    clientMs: distribution(rows.map((r) => r.clientMs)),
    cpuMs: distribution(rows.map((r) => cpu.get(r.requestId)?.cpuMs)),
    workerWallMs: distribution(rows.map((r) => cpu.get(r.requestId)?.wallMs)),
    responseBytes: distribution(rows.map((r) => r.bytes)),
    launchLagMs: distribution(rows.map((r) => r.launchLagMs)),
    inFlightAtStart: distribution(rows.map((r) => r.inFlightAtStart)),
    isolates: [
      ...new Set(
        rows
          .map(
            (r) =>
              cpu.get(r.requestId)?.telemetry?.isolate ?? r.result?.isolate,
          )
          .filter(Boolean),
      ),
    ],
    counters: Object.fromEntries(
      fields.map((f) => [
        f,
        distribution(rows.map((r) => r.result?.diagnostics?.[f])),
      ]),
    ),
  };
}
const groups = new Map<string, any[]>();
for (const row of data.rows) {
  const key = JSON.stringify([
    row.condition,
    row.variant,
    row.arrivalRate ?? null,
    row.q,
    row.options,
  ]);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(row);
}
const loadGroups = [];
for (const variant of ["control", "candidate"])
  for (const rate of [0.5, 2]) {
    const rows = data.rows.filter(
      (r: any) =>
        r.variant === variant &&
        r.arrivalRate === rate &&
        r.condition === "load",
    );
    if (rows.length)
      loadGroups.push({
        variant,
        rate,
        ...stats(rows),
        drainThroughputPerSecond:
          rows.length /
          (Math.max(...rows.map((r: any) => r.loadStartMs + r.clientMs)) /
            1000),
      });
  }
const result = {
  manifest: data.manifest,
  note: "Small randomized diagnostic pilot. Empirical P95/P99 are recorded but cannot estimate production tails reliably. Per-cell ranges describe observations, not confidence bounds. Load drain throughput is a finite-burst measurement, not steady-state capacity. Native tail wall/CPU can include deferred work; active-buffer counters are not heap peaks.",
  attempts: data.rows.length,
  correct: data.rows.filter((r: any) => r.correct).length,
  joinedCpu: data.rows.filter((r: any) => cpu.has(r.requestId)).length,
  groups: [...groups].map(([key, rows]) => ({
    key: JSON.parse(key),
    ...stats(rows),
  })),
  loadGroups,
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    attempts: result.attempts,
    correct: result.correct,
    joinedCpu: result.joinedCpu,
  }),
);
for (const g of result.groups.filter(
  (g) =>
    g.key[0] === "fresh-namespace" || g.key[0] === "shared-warm-memory-empty",
))
  console.log(
    g.key[0],
    g.key[1],
    g.key[3],
    JSON.stringify(g.key[4]),
    g.clientMs.p50,
    g.cpuMs.p50,
    g.counters.bytes.p50,
  );
