/** Recompute diagnostic distributions; small pilots are not traffic percentiles. */
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const [root = "bench/results/columnar/io-iteration-1m"] = process.argv.slice(2);
async function json(name: string) {
  const raw = await readFile(`${root}/${name}`);
  return JSON.parse((name.endsWith(".gz") ? gunzipSync(raw) : raw).toString());
}
function distribution(input: number[]) {
  const a = input.filter(Number.isFinite).sort((a, b) => a - b),
    n = a.length;
  return n
    ? {
        n,
        min: a[0],
        median: n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2,
        max: a[n - 1],
      }
    : { n };
}
function grouped(
  rows: any[],
  key: (r: any) => unknown,
  summarize: (rs: any[]) => unknown,
) {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = JSON.stringify(key(r));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups].map(([k, rs]) => ({
    key: JSON.parse(k),
    ...(summarize(rs) as object),
  }));
}
const counters = [
  "requests",
  "bytes",
  "sharedGets",
  "sharedPuts",
  "sharedBudgetBypasses",
  "memoryHits",
  "scoreBlocksFetched",
  "scoreBlocksDecoded",
  "scorePostingsDecoded",
  "postings",
  "positionIntegers",
  "forwardIntegers",
  "pairMembershipIntegers",
  "commonPresenceIntegers",
  "plannedPairPackets",
  "plannedPresenceLists",
  "anchorUnigramCandidates",
  "anchorIntersectionCandidates",
  "candidates",
  "positionIOWaves",
  "scoreIOWaves",
  "packageCandidates",
  "candidatePackageBytes",
  "packageFetchWaves",
  "packageIOWaves",
  "packagePipelineLoads",
  "packagePipelineWaits",
  "peakPackagePipelinePending",
  "peakPackageBatchBytes",
  "peakPackageNumericBytes",
  "peakPackagePositionBytes",
  "peakActiveBufferBytes",
  "peakWinnerPackageBytes",
  "peakPendingSharedBytes",
  "retainedPageBytes",
  "retainedDecodedBytes",
];
async function live(name: string, cpuName: string) {
  const data = await json(name),
    cpu = await json(cpuName),
    tails = new Map<string, any>(
      cpu.rows
        .filter((r: any) => r.requestId)
        .map((r: any) => [r.requestId, r]),
    );
  const stats = (rs: any[]) => ({
    attempts: rs.length,
    correct: rs.filter((r) => r.correct).length,
    errors: rs
      .filter((r) => r.status !== 200 || !r.correct)
      .map((r) => ({
        requestId: r.requestId,
        status: r.status,
        error: r.error ?? r.result?.error,
      })),
    clientMs: distribution(rs.map((r) => r.clientMs)),
    nativeCpuMs: distribution(rs.map((r) => tails.get(r.requestId)?.cpuMs)),
    nativeWallMs: distribution(rs.map((r) => tails.get(r.requestId)?.wallMs)),
    launchLagMs: distribution(rs.map((r) => r.launchLagMs)),
    inFlightAtStart: distribution(rs.map((r) => r.inFlightAtStart)),
    ...Object.fromEntries(
      counters.map((k) => [
        k,
        distribution(rs.map((r) => r.result?.diagnostics?.[k])),
      ]),
    ),
  });
  return {
    manifest: data.manifest,
    attempts: data.rows.length,
    correct: data.rows.filter((r: any) => r.correct).length,
    joinedCpu: data.rows.filter((r: any) => tails.has(r.requestId)).length,
    groups: grouped(
      data.rows,
      (r) => [r.condition, r.variant, r.arrivalRate ?? null, r.q],
      stats,
    ),
    loadGroups: grouped(
      data.rows.filter((r: any) => r.condition === "load"),
      (r) => [r.arrivalRate, r.variant],
      (rs) => ({
        ...stats(rs),
        drainThroughputPerSecond:
          rs.length /
          (Math.max(...rs.map((r) => r.loadStartMs + r.clientMs)) / 1000),
        note: "Finite arrival burst including drain; not steady-state capacity. In-flight counts/launch lag are client observations, not server queue depth.",
      }),
    ),
  };
}
async function local(name: string) {
  const data = await json(name);
  return {
    manifest: data.manifest,
    groups: grouped(
      data.rows,
      (r) => [r.q, r.options, r.plan],
      (rs) => ({
        wallMs: distribution(rs.map((r) => r.wallMs)),
        localProcessCpuMs: distribution(rs.map((r) => r.localProcessCpuMs)),
        semanticDigests: [...new Set(rs.map((r) => r.semanticSha256))],
        ...Object.fromEntries(
          counters.map((k) => [
            k,
            distribution(rs.map((r) => r.diagnostics?.[k])),
          ]),
        ),
      }),
    ),
  };
}
const expanded = await json("correctness-200.json.gz"),
  comparisons = grouped(
    expanded.rows,
    (r) => [r.q, r.options],
    (rs) => ({
      variants: rs.length,
      semanticDigests: [...new Set(rs.map((r) => r.semanticSha256))],
    }),
  );
const output = {
  note: "Medians/ranges of small diagnostic samples. No P95/P99 or production aggregate claims. See report for provenance/version differences and rejected pilot failure.",
  final: await live("live-final.json.gz", "live-final-cpu.json.gz"),
  broadPilot: await live(
    "live-broad-pilot.json.gz",
    "live-broad-pilot-cpu.json.gz",
  ),
  unfamiliarRecheck: await live(
    "live-unfamiliar.json.gz",
    "live-unfamiliar-cpu.json.gz",
  ),
  localEmpty: await local("local-empty.json.gz"),
  localWarm: await local("local-warm.json.gz"),
  localArbitrationEmpty: await local("local-arbitration-empty.json.gz"),
  localArbitrationWarm: await local("local-arbitration-warm.json.gz"),
  correctness: {
    responses: expanded.rows.length,
    queries: comparisons.length,
    differences: comparisons.filter(
      (g: any) => g.variants !== 2 || g.semanticDigests.length !== 1,
    ),
  },
};
await writeFile(`${root}/summary.json`, JSON.stringify(output, null, 2) + "\n");
console.log(
  JSON.stringify({
    correctness: output.correctness,
    final: {
      attempts: output.final.attempts,
      correct: output.final.correct,
      joinedCpu: output.final.joinedCpu,
    },
  }),
);
