import { readFile, writeFile } from "node:fs/promises";
import { constructionTail } from "./construction-tail.js";
const [input, controlTail, candidateTail, out] = process.argv.slice(2);
if (!out)
  throw Error("Use RESULTS_JSON CONTROL_TAIL CANDIDATE_TAIL OUTPUT_JSON");
const source = JSON.parse(await readFile(input, "utf8"));
const firsts: number[] = source.firsts ?? [0, 100000, 500000, 900000];
if (source.rows.length !== source.repetitions * firsts.length * 2)
  throw Error("Incomplete ingest CPU comparison");
const events = constructionTail(await readFile(controlTail, "utf8")).concat(
  constructionTail(await readFile(candidateTail, "utf8")),
);
const byRay = new Map(
  events.map((e) => [e.event?.request?.headers?.["cf-ray"]?.split("-")[0], e]),
);
const rows = source.rows.map((r: any) => {
  const event = byRay.get(r.ray);
  if (!event) throw Error("Missing native CPU observation " + r.ray);
  if (event.outcome !== "ok")
    throw Error("Native request outcome " + event.outcome);
  if (!Number.isFinite(event.cpuTime) || !Number.isFinite(event.wallTime))
    throw Error("Missing native CPU/wall timing");
  return {
    ...r,
    cpuMs: event.cpuTime,
    nativeWallMs: event.wallTime,
    outcome: event.outcome,
  };
});
const median = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const groups = firsts.map((first) => {
  const a = rows.filter((r: any) => r.first === first && !r.variant),
    b = rows.filter((r: any) => r.first === first && r.variant);
  const controlCpuMs = median(a.map((r: any) => r.cpuMs)),
    candidateCpuMs = median(b.map((r: any) => r.cpuMs));
  return {
    first,
    samplesPerVariant: a.length,
    documents: a[0].documents,
    tokens: b[0].analysisWork.tokens,
    controlCpuMs,
    candidateCpuMs,
    cpuReductionPercent: (1 - candidateCpuMs / controlCpuMs) * 100,
    controlClientMs: median(a.map((r: any) => r.ms)),
    candidateClientMs: median(b.map((r: any) => r.ms)),
    stemCalls: b[0].analysisWork.stemCalls,
    cacheHits: b[0].analysisWork.cacheHits,
    maxCacheBytes: b[0].analysisWork.maxCacheBytes,
  };
});
const controlCpuMs = rows
    .filter((r: any) => !r.variant)
    .reduce((n: number, r: any) => n + r.cpuMs, 0),
  candidateCpuMs = rows
    .filter((r: any) => r.variant)
    .reduce((n: number, r: any) => n + r.cpuMs, 0);
// Resample within each range and variant, so differences in document size do
// not change the workload mix. This describes these measurements only.
let randomState = 516702;
function random() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 4294967296;
}
const bootstrap: number[] = [];
for (let iteration = 0; iteration < 5000; iteration++) {
  const sums = [0, 0];
  for (const { first } of groups)
    for (const variant of [0, 1]) {
      const sample = rows.filter(
        (r: any) => r.first === first && r.variant === variant,
      );
      for (let i = 0; i < sample.length; i++)
        sums[variant] += sample[Math.floor(random() * sample.length)].cpuMs;
    }
  bootstrap.push((1 - sums[1] / sums[0]) * 100);
}
bootstrap.sort((a, b) => a - b);
await writeFile(
  out,
  JSON.stringify(
    {
      ...source,
      rows,
      groups,
      totalCpu: {
        controlCpuMs,
        candidateCpuMs,
        reductionPercent: (1 - candidateCpuMs / controlCpuMs) * 100,
        bootstrap95ReductionPercent: [bootstrap[125], bootstrap[4874]],
        bootstrapSeed: 516702,
        bootstrapSamples: bootstrap.length,
      },
      limitations: [
        `${source.repetitions} observations per range and variant; pilot sample, not production percentiles.`,
        "The bootstrap interval resamples within each range and variant; it does not account for systematic host differences, temporal effects, or represent full-corpus uncertainty.",
        "Client latency includes uncontrolled remote I/O; CPU is measured separately by Cloudflare.",
        "The source ranges and expanded posting bytes are identical. No cache warming assumption is used.",
      ],
    },
    null,
    2,
  ),
);
console.table(groups);
console.log("Total CPU", {
  controlCpuMs,
  candidateCpuMs,
  reductionPercent: (1 - candidateCpuMs / controlCpuMs) * 100,
});
