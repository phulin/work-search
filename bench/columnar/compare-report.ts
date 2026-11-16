import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
const [responses, cpuPath, output] = process.argv.slice(2);
if (!output) throw Error("Use RESPONSES_GZ CPU_GZ OUTPUT_GZ");
const run = JSON.parse(gunzipSync(await readFile(responses)).toString()),
  observations = JSON.parse(gunzipSync(await readFile(cpuPath)).toString()),
  native = new Map(
    observations.rows
      .filter((r: any) => r.requestId)
      .map((r: any) => [r.requestId, r]),
  ),
  rows = run.rows.map((r: any) => ({ ...r, native: native.get(r.requestId) }));
function quantile(a: number[], p: number) {
  const sorted = a.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}
function distribution(a: number[]) {
  return {
    n: a.length,
    p50: quantile(a, 0.5),
    p95: quantile(a, 0.95),
    p99: quantile(a, 0.99),
    max: quantile(a, 1),
  };
}
const counters = [
  "requests",
  "bytes",
  "sharedGets",
  "sharedPuts",
  "memoryHits",
  "scoreBlocksFetched",
  "scorePostingsDecoded",
  "scoreIOWaves",
  "positionIOWaves",
  "anchorIOWaves",
  "positionIntegers",
  "pairContextIntegers",
  "pairPositionChunks",
  "pairPositionBytes",
  "exactPhraseReads",
  "exactPhraseBytes",
  "resultRequests",
  "resultBytes",
  "metadataMs",
  "peakActiveBufferBytes",
  "peakExactPhraseBufferBytes",
  "retainedPageBytes",
  "retainedDecodedBytes",
  "repeatedDecodedBytes",
];
function summarize(selected: any[]) {
  const good = selected.filter((r) => r.status === 200 && !r.error);
  return {
    requests: selected.length,
    successes: good.length,
    errors: selected
      .filter((r) => r.status !== 200 || r.error)
      .map((r) => ({
        sid: r.sid,
        status: r.status,
        error: r.error ?? r.result?.error,
      })),
    clientMs: distribution(good.map((r) => r.clientMs)),
    workerWallMs: distribution(good.map((r) => r.result.telemetry.wallMs)),
    workerCpuMs: distribution(
      good
        .filter((r) => typeof r.native?.cpuMs === "number")
        .map((r) => r.native.cpuMs),
    ),
    counters: Object.fromEntries(
      counters.map((key) => [
        key,
        distribution(good.map((r) => r.result.diagnostics[key] ?? 0)),
      ]),
    ),
    nativeOutcomes: selected.reduce((a, r) => {
      const k = r.native?.outcome ?? "missing";
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {}),
  };
}
const summaries = Object.fromEntries(
    run.names.map((name: string) => [
      name,
      summarize(rows.filter((r: any) => r.name === name)),
    ]),
  ),
  scenarios = run.scenarios.map((s: any) => ({
    ...s,
    variants: Object.fromEntries(
      run.names.map((name: string) => [
        name,
        summarize(rows.filter((r: any) => r.name === name && r.sid === s.sid)),
      ]),
    ),
  })),
  classes = Object.fromEntries(
    [...new Set<string>(run.scenarios.map((s: any) => s.kind))].map((kind) => [
      kind,
      Object.fromEntries(
        run.names.map((name: string) => [
          name,
          summarize(
            rows.filter(
              (r: any) =>
                r.name === name &&
                run.scenarios.find((s: any) => s.sid === r.sid)?.kind === kind,
            ),
          ),
        ]),
      ),
    ]),
  );
// Resample entire scenarios, retaining repeat sessions and pairing both engines.
// This describes uncertainty over the chosen workload, not production traffic.
let seed = 861923;
const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32,
  bootstrap: any[] = [],
  byScenario = new Map(
    scenarios.map((s: any) => [
      s.sid,
      rows.filter((r: any) => r.sid === s.sid && r.status === 200 && !r.error),
    ]),
  );
for (let b = 0; b < 1000; b++) {
  const sampled = Array.from(
    { length: scenarios.length },
    () =>
      byScenario.get(
        scenarios[Math.floor(random() * scenarios.length)].sid,
      ) as any[],
  ).flat();
  bootstrap.push(
    Object.fromEntries(
      run.names.map((name: string) => [
        name,
        [0.5, 0.95, 0.99].map((p) =>
          quantile(
            sampled.filter((r) => r.name === name).map((r) => r.clientMs),
            p,
          ),
        ),
      ]),
    ),
  );
}
const uncertainty = Object.fromEntries(
    run.names.map((name: string) => [
      name,
      Object.fromEntries(
        ["p50", "p95", "p99"].map((key, i) => [
          key,
          [
            quantile(
              bootstrap.map((r) => r[name][i]),
              0.025,
            ),
            quantile(
              bootstrap.map((r) => r[name][i]),
              0.975,
            ),
          ],
        ]),
      ),
    ]),
  ),
  differences = scenarios.map((s: any) => ({
    sid: s.sid,
    q: s.q,
    controlMs: s.variants[run.names[0]].clientMs.p50,
    candidateMs: s.variants[run.names[1]].clientMs.p50,
    controlCpu: s.variants[run.names[0]].workerCpuMs.p50,
    candidateCpu: s.variants[run.names[1]].workerCpuMs.p50,
    controlReads: s.variants[run.names[0]].counters.requests.p50,
    candidateReads: s.variants[run.names[1]].counters.requests.p50,
    controlBytes: s.variants[run.names[0]].counters.bytes.p50,
    candidateBytes: s.variants[run.names[1]].counters.bytes.p50,
  })),
  report = {
    provenance: Object.fromEntries(
      Object.entries(run).filter(([key]) => key !== "rows"),
    ),
    summaries,
    uncertainty,
    classes,
    scenarios,
    differences,
    notes: [
      "Empty application caches in request; fresh shared namespace. Isolates and opaque R2 backend caches are not controlled.",
      "Native CPU coverage is sampled and joined by request ID. Software buffer counters are not native peak heap measurements.",
      "Percentiles describe this query workload. Three repetitions per query do not establish production P99.",
    ],
  };
await writeFile(output, gzipSync(JSON.stringify(report)));
console.log(
  JSON.stringify(
    {
      summaries,
      uncertainty,
      regressions: differences
        .sort(
          (a: any, b: any) =>
            b.candidateMs - b.controlMs - (a.candidateMs - a.controlMs),
        )
        .slice(0, 12),
    },
    null,
    2,
  ),
);
