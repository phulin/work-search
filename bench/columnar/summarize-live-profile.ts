import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
const [
  input = "work/live-profile-1m",
  output = "bench/results/columnar/live-profile-1m",
] = process.argv.slice(2);
await mkdir(output, { recursive: true });
async function json(path: string) {
  const data = await readFile(path);
  return JSON.parse(
    (path.endsWith(".gz") ? gunzipSync(data) : data).toString(),
  );
}
function distribution(values: number[]) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b),
    n = v.length;
  return n
    ? {
        n,
        min: v[0],
        median: n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2,
        max: v[n - 1],
      }
    : { n };
}
function union(ranges: number[][]) {
  let end = -Infinity,
    bytes = 0;
  for (const [a, b] of ranges.sort((a, b) => a[0] - b[0])) {
    bytes += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return bytes;
}
function physical(records: any[]) {
  const objects = new Map<string, number[][]>();
  for (const r of records) {
    let ranges = objects.get(r.key);
    if (!ranges) objects.set(r.key, (ranges = []));
    ranges.push([r.offset, r.offset + r.length]);
  }
  return [...objects.values()].reduce((n, ranges) => n + union(ranges), 0);
}
function trace(row: any) {
  const p = row.result.liveProfile,
    events = p.events as any[];
  const kinds = [...new Set<string>(events.map((e) => e.kind))];
  const durations = (es: any[]) =>
    es.map((e) =>
      Math.max(0, Math.min(e.end ?? p.elapsedMs, p.elapsedMs) - e.start),
    );
  const spans = Object.fromEntries(
    kinds.map((kind) => {
      const es = events.filter((e) => e.kind === kind);
      return [
        kind,
        {
          count: es.length,
          unfinished: es.filter((e) => e.end === undefined).length,
          errors: es.filter((e) => e.error).length,
          durationMs: distribution(durations(es)),
          unionMs: union(
            es.map((e) => [
              e.start,
              Math.min(e.end ?? p.elapsedMs, p.elapsedMs),
            ]),
          ),
          hits: es.filter((e) => e.hit).length,
        },
      ];
    }),
  );
  const origins = events.filter((e) => e.kind === "r2.get");
  const ranges = origins.map((e) => ({
    key: e.key,
    offset: e.offset,
    length: e.bytes,
  }));
  const pages = new Set<string>();
  for (const r of p.logical)
    for (
      let i = Math.floor(r.offset / 262144);
      i <= Math.floor((r.offset + r.length - 1) / 262144);
      i++
    )
      pages.add(r.key + ":" + i);
  const queue = events
    .filter((e) => e.kind === "io-service")
    .map((e) => e.start - events[e.parent].start);
  const unscopedReads = events.filter(
    (e) => e.kind === "posting-read" && events[e.parent]?.kind !== "score",
  );
  return {
    sid: row.sid,
    condition: row.condition,
    requestId: row.requestId,
    clientMs: row.clientMs,
    elapsedMs: p.elapsedMs,
    dropped: p.dropped,
    spans,
    semaphoreQueueMs: distribution(queue),
    logicalUniqueBytes: physical(p.logical),
    logicalPageEnvelopeBytes: pages.size * 262144,
    originBytes: ranges.reduce((n, r) => n + r.length, 0),
    originUniqueBytes: physical(ranges),
    unscopedPostingReads: {
      count: unscopedReads.length,
      unionMs: union(unscopedReads.map((e) => [e.start, e.end ?? p.elapsedMs])),
    },
    continuations: p.continuations,
    diagnostics: row.result.diagnostics,
  };
}
const baseline = await json(input + "/baseline.json"),
  tails = await json("work/columnar-bench/live-profile-1m-base-cpu.json.gz"),
  byRequest = new Map<string, any>(
    tails.rows.map((r: any) => [r.requestId, r]),
  ),
  groups: any[] = [];
for (const sid of baseline.selected)
  for (const condition of baseline.conditions) {
    const rows = baseline.rows.filter(
        (r: any) => r.sid === sid && r.condition === condition,
      ),
      stats = (key: string) =>
        distribution(rows.map((r: any) => r.result.diagnostics[key]));
    groups.push({
      sid,
      q: rows[0].q,
      condition,
      clientMs: distribution(rows.map((r: any) => r.clientMs)),
      nativeCpuMs: distribution(
        rows.map((r: any) => byRequest.get(r.requestId)?.cpuMs),
      ),
      nativeWallMs: distribution(
        rows.map((r: any) => byRequest.get(r.requestId)?.wallMs),
      ),
      ...Object.fromEntries(
        [
          "requests",
          "bytes",
          "sharedGets",
          "sharedPuts",
          "sharedBudgetBypasses",
          "memoryHits",
          "scorePostingsDecoded",
          "scoreBlocksDecoded",
          "positionIntegers",
          "pairMembershipIntegers",
          "commonPresenceIntegers",
          "positionIOWaves",
          "scoreIOWaves",
          "packageIOWaves",
          "candidates",
          "metadataMs",
          "resultBytes",
          "decodedBytes",
          "repeatedDecodedBytes",
          "peakActiveBufferBytes",
          "retainedPageBytes",
          "retainedDecodedBytes",
        ].map((k) => [k, stats(k)]),
      ),
    });
  }
const details = await json(input + "/detail.json"),
  continuation = await json(input + "/continuation.json"),
  budget = await json(input + "/budget.json");
const repeats = baseline.rows.filter(
  (r: any) => r.condition === "immediate-repeat",
);
const summary = {
  baseline: {
    url: baseline.url,
    health: baseline.health,
    startedAt: baseline.startedAt,
    completedAt: baseline.completedAt,
    requests: baseline.rows.length,
    nativeCoverage: baseline.rows.filter((r: any) => byRequest.has(r.requestId))
      .length,
    allChecksPassed: baseline.allChecksPassed,
    isolates: new Set(baseline.rows.map((r: any) => r.result.telemetry.isolate))
      .size,
    colos: [...new Set(baseline.rows.map((r: any) => r.result.colo))],
    immediateRepeats: repeats.length,
    sameIsolateImmediateRepeats: repeats.filter(
      (r: any) =>
        baseline.rows.find(
          (x: any) =>
            x.sid === r.sid &&
            x.session === r.session &&
            x.condition === baseline.conditions[0],
        ).result.telemetry.isolate === r.result.telemetry.isolate,
    ).length,
    groups,
  },
  detail: details.rows.map(trace),
  continuation: continuation.rows.map(trace),
  budgetOverride: {
    limit: budget.sharedBudgetOverride,
    allChecksPassed: budget.allChecksPassed,
    rows: budget.rows.map(trace),
  },
  notes: [
    "Three sessions per baseline cell; diagnostic sample, no reliable P95/P99 estimate.",
    "Native wall includes post-response activity; client time measures complete response. Span unions overlap and must not be added; Worker clock advances only on I/O and does not attribute CPU.",
    "Logical page envelope rounds complete pages up; object tails can be shorter. Logical ranges include planning, scores and positions; named objects/document packages are reported separately by events.",
    "Cache-budget ablation is diagnostic, not a production setting; consult current Cache API limits.",
  ],
};
await writeFile(
  output + "/summary.json",
  JSON.stringify(summary, null, 2) + "\n",
);
for (const name of ["baseline", "detail", "continuation", "budget"])
  await writeFile(
    output + "/" + name + ".json.gz",
    gzipSync(await readFile(input + "/" + name + ".json")),
  );
for (const [label, name] of [
  ["base", "baseline"],
  ["detail", "detail"],
  ["cost", "continuation"],
  ["budget", "budget"],
])
  await writeFile(
    output + "/" + name + "-native.json.gz",
    await readFile(`work/columnar-bench/live-profile-1m-${label}-cpu.json.gz`),
  );
for (const name of ["native-production", "native-held-isolate"]) {
  const artifacts: Record<string, unknown> = {
    captures: await json(input + "/" + name + "/captures.json"),
  };
  for (const type of ["cpu", "heap"]) {
    artifacts[type + "Traffic"] = await json(
      input + "/" + name + "/" + type + "-traffic.json",
    );
    await writeFile(
      output + "/" + name + "-" + type + ".pprof",
      await readFile(input + "/" + name + "/" + type + ".pprof"),
    );
  }
  await writeFile(
    output + "/" + name + ".json.gz",
    gzipSync(JSON.stringify(artifacts)),
  );
}
console.log(
  "Saved",
  output,
  "baseline rows",
  baseline.rows.length,
  "native joined",
  summary.baseline.nativeCoverage,
);
