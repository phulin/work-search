import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
const [responses, cpuPath, output] = process.argv.slice(2);
if (!output) throw Error("Use RESPONSES_GZ CPU_GZ OUTPUT_GZ");
const run = JSON.parse(gunzipSync(await readFile(responses)).toString()),
  observations = JSON.parse(gunzipSync(await readFile(cpuPath)).toString()),
  cpu = new Map(
    observations.rows
      .filter((r: any) => r.requestId)
      .map((r: any) => [r.requestId, r]),
  ),
  rows = run.rows.map((r: any) => ({ ...r, native: cpu.get(r.requestId) }));
function quantile(values: number[], p: number) {
  if (!values.length) return null;
  return values.slice().sort((a, b) => a - b)[
    Math.max(0, Math.ceil(p * values.length) - 1)
  ];
}
function distribution(values: number[]) {
  return {
    n: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: quantile(values, 1),
  };
}
function summarize(rows: any[]) {
  const successful = rows.filter((r) => r.status === 200 && !r.error),
    diagnostics = successful.map((r) => r.result.diagnostics);
  const counters = [
    "requests",
    "bytes",
    "scoreBlocksFetched",
    "scorePostingsDecoded",
    "scoreIOWaves",
    "positionIOWaves",
    "positionIntegers",
    "pairContextIntegers",
    "resultRequests",
    "resultBytes",
    "metadataMs",
    "peakActiveBufferBytes",
    "retainedPageBytes",
    "retainedDecodedBytes",
    "repeatedDecodedBytes",
  ];
  return {
    requests: rows.length,
    successes: successful.length,
    errors: rows
      .filter((r) => r.status !== 200 || r.error)
      .map((r) => ({
        sid: r.sid,
        status: r.status,
        error: r.error ?? r.result?.error,
      })),
    clientMs: distribution(successful.map((r) => r.clientMs)),
    workerCpuMs: distribution(
      successful.flatMap((r) =>
        typeof r.native?.cpuMs === "number" ? [r.native.cpuMs] : [],
      ),
    ),
    workerWallMs: distribution(
      successful.map((r) => r.result.telemetry.wallMs),
    ),
    nativeOutcomes: rows.reduce((v, r) => {
      const k = r.native?.outcome ?? "missing";
      v[k] = (v[k] ?? 0) + 1;
      return v;
    }, {}),
    counters: Object.fromEntries(
      counters.map((key) => [
        key,
        distribution(diagnostics.map((d) => d[key] ?? 0)),
      ]),
    ),
    repeatabilityChecks: successful.filter((r) => r.repeatabilityChecked)
      .length,
  };
}
// Approximate percentile uncertainty by resampling query scenarios. This is
// workload-sampling uncertainty, not a confidence interval for traffic or regions.
let seed = 728145;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const latencies = rows
    .filter((r: any) => r.status === 200 && !r.error)
    .map((r: any) => r.clientMs),
  bootstrap = Array.from({ length: 2000 }, () => {
    const sample = latencies.map(
      () => latencies[Math.floor(random() * latencies.length)],
    );
    return [0.5, 0.95, 0.99].map((p) => quantile(sample, p)!);
  });
const report = {
  ...run,
  rows,
  summary: summarize(rows),
  workloadBootstrap95: Object.fromEntries(
    ["p50", "p95", "p99"].map((key, i) => [
      key,
      [
        quantile(
          bootstrap.map((r) => r[i]),
          0.025,
        ),
        quantile(
          bootstrap.map((r) => r[i]),
          0.975,
        ),
      ],
    ]),
  ),
  classes: Object.fromEntries(
    [...new Set<string>(run.scenarios.map((s: any) => s.kind))].map((kind) => [
      kind,
      summarize(rows.filter((r: any) => run.scenarios[r.sid].kind === kind)),
    ]),
  ),
  worst: rows
    .filter((r: any) => r.status === 200 && !r.error)
    .sort((a: any, b: any) => b.clientMs - a.clientMs)
    .slice(0, 20)
    .map((r: any) => ({
      sid: r.sid,
      q: r.q,
      clientMs: r.clientMs,
      cpuMs: r.native?.cpuMs,
      diagnostics: r.result.diagnostics,
    })),
};
await writeFile(output, gzipSync(JSON.stringify(report)));
console.log(
  JSON.stringify(
    {
      summary: report.summary,
      uncertainty: report.workloadBootstrap95,
      worst: report.worst.slice(0, 10).map((r: any) => ({
        q: r.q,
        ms: r.clientMs,
        cpuMs: r.cpuMs,
        reads: r.diagnostics.requests,
        bytes: r.diagnostics.bytes,
        scoreWaves: r.diagnostics.scoreIOWaves,
        positionWaves: r.diagnostics.positionIOWaves,
      })),
    },
    null,
    2,
  ),
);
