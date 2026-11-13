import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const labels = process.argv.slice(2);
if (!labels.length)
  throw Error(
    "Usage: yarn node --import tsx bench/columnar/report.ts LABEL...",
  );
const out = "bench/results/columnar";
await mkdir(out, { recursive: true });
const quantile = (a: number[], p: number) =>
  a.length
    ? [...a].sort((a, b) => a - b)[
        Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p) - 1))
      ]
    : undefined;
function distribution(a: number[]) {
  a = a.filter(Number.isFinite);
  return {
    n: a.length,
    p50: quantile(a, 0.5),
    p95: quantile(a, 0.95),
    p99: quantile(a, 0.99),
    max: quantile(a, 1),
  };
}
let seed = 20261112;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
function uncertainty(rows: any[]) {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.session, row.q, row.options]);
    const a = groups.get(key) ?? [];
    a.push(row.ms);
    groups.set(key, a);
  }
  const blocks = [...groups.values()],
    samples = [[], [], []] as number[][];
  if (blocks.length < 2) return { blocks: blocks.length };
  for (let i = 0; i < 1000; i++) {
    const a: number[] = [];
    for (let j = 0; j < blocks.length; j++)
      a.push(...blocks[Math.floor(random() * blocks.length)]);
    for (const [k, p] of [0.5, 0.95, 0.99].entries())
      samples[k].push(quantile(a, p)!);
  }
  return {
    method:
      "1000 query/session-block bootstrap resamples; conditional on this workload, not production traffic",
    blocks: blocks.length,
    p50: [quantile(samples[0], 0.025), quantile(samples[0], 0.975)],
    p95: [quantile(samples[1], 0.025), quantile(samples[1], 0.975)],
    p99: [quantile(samples[2], 0.025), quantile(samples[2], 0.975)],
    tailCaution:
      rows.length < 1000
        ? "Pilot has too few tail observations for a reliable P99 estimate"
        : undefined,
  };
}
const reports = [];
for (const label of labels) {
  const bytes = await readFile(`work/columnar-bench/${label}.json.gz`),
    data = JSON.parse(gunzipSync(bytes).toString()),
    tail = await readFile(`work/columnar-bench/${label}-cpu.json.gz`).then(
      (b) => JSON.parse(gunzipSync(b).toString()),
      () => ({ rows: [] }),
    );
  await writeFile(`${out}/${label}.json.gz`, bytes);
  if (tail.rows.length)
    await writeFile(
      `${out}/${label}-cpu.json.gz`,
      gzipSync(JSON.stringify(tail)),
    );
  const cpu = new Map(
    tail.rows.map((r: any) => [r.telemetry?.requestId ?? r.requestId, r]),
  );
  const rows = data.rows.filter((r: any) => !r.warmup),
    names = [...new Set<string>(rows.map((r: any) => r.name))],
    groups = [];
  for (const name of names)
    for (const kind of [
      "all-scenarios",
      ...new Set<string>(
        rows.filter((r: any) => r.name === name).map((r: any) => r.kind),
      ),
    ]) {
      const selected = rows.filter(
          (r: any) =>
            r.name === name && (kind === "all-scenarios" || r.kind === kind),
        ),
        ok = selected.filter(
          (r: any) => !r.error && (r.status === 200 || r.correct === true),
        ),
        joined = selected.flatMap((r: any) =>
          cpu.has(r.requestId) ? [cpu.get(r.requestId)] : [],
        ),
        sum = (path: string) =>
          ok.reduce(
            (s: number, r: any) =>
              s +
              (r.diagnostics?.[path] ?? 0) +
              (r.diagnostics?.pair?.[path] ?? 0),
            0,
          ),
        errors: Record<string, number> = {};
      for (const row of selected)
        if (row.error || row.status !== 200 || row.correct === false) {
          const key = String(row.status ?? row.error);
          errors[key] = (errors[key] ?? 0) + 1;
        }
      const start = Math.min(
          ...selected.map((r: any) =>
            Date.parse(r.startedAt ?? data.manifest.startedAt),
          ),
        ),
        end = Math.max(
          ...selected.map(
            (r: any) =>
              Date.parse(r.startedAt ?? data.manifest.startedAt) +
              (r.driverRoundtripMs ?? r.ms),
          ),
        );
      groups.push({
        name,
        kind,
        attempts: selected.length,
        successes: ok.length,
        errors,
        correctnessFailures: selected.filter((r: any) => r.correct === false)
          .length,
        clientSuccessMs: distribution(ok.map((r: any) => r.ms)),
        clientAllOutcomesMs: distribution(selected.map((r: any) => r.ms)),
        clientIncludingQueueMs: distribution(
          ok.map((r: any) => r.completeMs ?? r.ms),
        ),
        uncertainty: uncertainty(ok),
        arrivalLatenessMs: distribution(
          selected.map((r: any) => r.arrivalLatenessMs),
        ),
        sampledCpuMs: distribution(joined.map((r: any) => r.cpuMs)),
        sampledWorkerWallMs: distribution(joined.map((r: any) => r.wallMs)),
        tailJoined: joined.length,
        workerReportedWallMs: distribution(
          ok.map((r: any) => r.telemetry?.wallMs),
        ),
        metadataMs: distribution(ok.map((r: any) => r.diagnostics?.metadataMs)),
        activeBufferBytes: distribution(
          ok.map((r: any) => r.diagnostics?.peakActiveBufferBytes),
        ),
        observedColos: [...new Set(ok.map((r: any) => r.colo))],
        observedIsolates: [...new Set(ok.map((r: any) => r.telemetry?.isolate))]
          .length,
        completionThroughputPerSec: selected.some((r: any) => r.startedAt)
          ? selected.length / ((end - start) / 1000)
          : undefined,
        totals: Object.fromEntries(
          [
            "requests",
            "bytes",
            "sharedGets",
            "sharedPuts",
            "memoryHits",
            "deduplicated",
            "stages",
            "postings",
            "candidates",
            "positionIntegers",
            "pairContextIntegers",
            "forwardIntegers",
            "resultRequests",
            "resultBytes",
            "resultSharedGets",
            "resultMemoryHits",
            "coalescedReads",
            "coalescedExtraBytes",
            "decodedBytes",
            "repeatedDecodedBytes",
            "inflatedBytes",
            "repeatedInflatedBytes",
          ].map((k) => [k, sum(k)]),
        ),
      });
    }
  const result = {
    label,
    manifest: {
      ...data.manifest,
      queries: data.manifest.queries?.map(({ oracle, ...query }: any) => ({
        ...query,
        ...(oracle
          ? {
              oracleSha256: createHash("sha256")
                .update(JSON.stringify(oracle))
                .digest("hex"),
            }
          : {}),
      })),
    },
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    groups,
  };
  reports.push(result);
  await writeFile(
    `${out}/${label}-summary.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(
    label,
    groups
      .filter((g) => g.kind === "all-scenarios")
      .map((g) => ({
        name: g.name,
        n: g.attempts,
        errors: g.errors,
        ms: g.clientSuccessMs,
        cpu: g.sampledCpuMs,
      })),
  );
}
const previous = await readFile(out + "/summary.json", "utf8").then(
  JSON.parse,
  () => [],
);
await writeFile(
  out + "/summary.json",
  JSON.stringify(
    [...previous.filter((r: any) => !labels.includes(r.label)), ...reports],
    null,
    2,
  ),
);
