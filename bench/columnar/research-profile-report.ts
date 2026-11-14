import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
} from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
const [input, output] = process.argv.slice(2);
if (!output) throw Error("Usage: research-profile-report.ts INPUT OUTPUT");
const load = async (name: string) =>
  JSON.parse(
    gunzipSync(await readFile(input + "/" + name + ".json.gz")).toString(),
  );
const measured = await load("measure"),
  profiled = await load("profile"),
  workload = JSON.parse(await readFile(input + "/queries.json", "utf8"));
if (
  measured.manifest.implementationSha256 !==
    profiled.manifest.implementationSha256 ||
  measured.manifest.inputSha256 !== profiled.manifest.inputSha256 ||
  measured.downloads ||
  profiled.downloads ||
  measured.errors.length ||
  profiled.errors.length
)
  throw Error("Inconsistent sources, errors or nonlocal data");
const qs = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
  };
};
const median = (values: number[]) => qs(values).p50;
const sorted = (m: Map<string, number>) =>
  Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
const allSelf = new Map<string, number>(),
  allAllocation = new Map<string, number>();
const key = (frame: any) =>
  `${frame.functionName || "(anonymous)"}:${frame.url.split("/").slice(-2).join("/")}:${frame.lineNumber + 1}`;
const queries = [];
await mkdir(output + "/profiles", { recursive: true });
for (const q of workload.queries) {
  const ms = measured.rows.filter((r: any) => r.brief_id === q.brief_id),
    ps = profiled.rows.filter((r: any) => r.brief_id === q.brief_id);
  if (
    ms.length !== measured.manifest.repeats * 3 ||
    ps.length !== 6 ||
    new Set([...ms, ...ps].map((r: any) => r.resultSha256)).size !== 1
  )
    throw Error("Incomplete/mismatched query: " + q.brief_id);
  const cpuName = q.brief_id + ".cpuprofile.gz",
    heapName = q.brief_id + ".heapprofile.gz",
    cpu = JSON.parse(
      gunzipSync(await readFile(input + "/profiles/" + cpuName)).toString(),
    ),
    heap = JSON.parse(
      gunzipSync(await readFile(input + "/profiles/" + heapName)).toString(),
    ),
    nodes = new Map<number, any>(cpu.nodes.map((n: any) => [n.id, n])),
    parents = new Map<number, number>(),
    self = new Map<string, number>(),
    inclusive = new Map<string, number>(),
    alloc = new Map<string, number>();
  for (const n of cpu.nodes)
    for (const id of n.children ?? []) parents.set(id, n.id);
  for (let i = 0; i < cpu.samples.length; i++) {
    const id = cpu.samples[i],
      us = cpu.timeDeltas[i],
      name = key(nodes.get(id).callFrame);
    self.set(name, (self.get(name) ?? 0) + us);
    allSelf.set(name, (allSelf.get(name) ?? 0) + us);
    for (let p: number | undefined = id; p !== undefined; p = parents.get(p)) {
      const k = key(nodes.get(p).callFrame);
      inclusive.set(k, (inclusive.get(k) ?? 0) + us);
    }
  }
  const walk = (n: any) => {
    const k = key(n.callFrame);
    alloc.set(k, (alloc.get(k) ?? 0) + n.selfSize);
    allAllocation.set(k, (allAllocation.get(k) ?? 0) + n.selfSize);
    for (const c of n.children ?? []) walk(c);
  };
  walk(heap.head);
  const conditions: Record<string, any> = {};
  for (const condition of [
    "memory-reuse",
    "shared-warm-memory-empty",
    "cpu-no-delays",
  ]) {
    const rows = ms.filter((r: any) => r.condition === condition),
      diagnosticKeys = new Set<string>(
        rows.flatMap((r: any) => Object.keys(r.diagnostics)),
      );
    conditions[condition] = {
      wallMs: qs(rows.map((r: any) => r.wallMs)),
      cpuMs: qs(rows.map((r: any) => r.cpuMs)),
      batchCpuMs: qs(rows.map((r: any) => r.batchCpuMs)),
      counters: Object.fromEntries(
        [...diagnosticKeys]
          .filter((k) =>
            rows.every((r: any) => typeof r.diagnostics[k] === "number"),
          )
          .map((k) => [k, median(rows.map((r: any) => r.diagnostics[k]))]),
      ),
      modeledIO: Object.fromEntries(
        Object.keys(rows[0].modeledIO).map((k) => [
          k,
          median(rows.map((r: any) => r.modeledIO[k])),
        ]),
      ),
    };
  }
  queries.push({
    ...q,
    resultCount: ms[0].resultCount,
    resultSha256: ms[0].resultSha256,
    executor: ms[0].diagnostics.executor ?? "empty",
    conditions,
    cpuProfileCalls: 4,
    allocationProfileCalls: 2,
    selfMicros: sorted(self),
    inclusiveMicros: sorted(inclusive),
    sampledAllocationBytes: sorted(alloc),
    estimatedAllocationBytesPerCall:
      [...alloc.values()].reduce((a, b) => a + b, 0) / 2,
  });
  for (const name of [cpuName, heapName])
    await copyFile(input + "/profiles/" + name, output + "/profiles/" + name);
}
if (queries.length !== 180) throw Error("Incomplete workload");
const aggregates = [];
for (const style of ["all", "boolean", "proximity"])
  for (const hits of ["all", "nonempty", "empty"]) {
    const selected = queries.filter(
      (q) =>
        (style === "all" || q.query_style === style) &&
        (hits === "all" || q.resultCount > 0 === (hits === "nonempty")),
    );
    if (!selected.length) continue;
    aggregates.push({
      style,
      hits,
      n: selected.length,
      cpuMs: qs(selected.map((q) => q.conditions["cpu-no-delays"].cpuMs.p50)),
      memoryReuseMs: qs(
        selected.map((q) => q.conditions["memory-reuse"].wallMs.p50),
      ),
      sharedWarmMs: qs(
        selected.map(
          (q) => q.conditions["shared-warm-memory-empty"].wallMs.p50,
        ),
      ),
      scoreIOWaves: qs(
        selected.map(
          (q) => q.conditions["memory-reuse"].counters.scoreIOWaves ?? 0,
        ),
      ),
    });
  }
const summary = {
  kind: "180-query local 1M profile; no production latency claims",
  manifests: [measured.manifest, profiled.manifest],
  requests: {
    measured: measured.rows.length,
    cpuProfile: 180 * 4,
    allocationProfile: 180 * 2,
  },
  validation:
    "180 exact response hashes agree across all cache states, repetitions and inspector passes. No independent exhaustive oracle or relevance judgments for this new workload.",
  caveats: [
    "Quantiles summarize 180 equally weighted per-query medians, not traffic or individual query tails.",
    "CPU sampled wall-time attribution includes idle/file I/O; do not interpret raw sample time as process CPU.",
    "Allocation sampling estimates cumulative allocation, including collected objects; not retained or peak memory.",
    "CPU and heap profiles use no simulated delays and run in a separate process from measurements.",
    "Per-query repeated reuse with explicitly primed shared data; not inter-query cache capacity or startup measurements.",
    "W/P=75 tokens and W/S=25 tokens under existing engine semantics. Nine explicit finite rewrites, not general Lexis expansion.",
  ],
  aggregates,
  allSelfMicros: sorted(allSelf),
  allSampledAllocationBytes: sorted(allAllocation),
  queries,
};
await mkdir(output, { recursive: true });
await writeFile(output + "/summary.json.gz", gzipSync(JSON.stringify(summary)));
for (const name of ["measure.json.gz", "profile.json.gz", "queries.json"])
  await copyFile(input + "/" + name, output + "/" + name);
await writeFile(
  output + "/aggregates.json",
  JSON.stringify(
    {
      requests: summary.requests,
      aggregates,
      allSelfMicros: summary.allSelfMicros,
      allSampledAllocationBytes: summary.allSampledAllocationBytes,
    },
    null,
    2,
  ) + "\n",
);
const columns = [
  "brief_id",
  "style",
  "query",
  "rewritten",
  "returned",
  "executor",
  "cpu_ms",
  "memory_reuse_ms",
  "shared_warm_ms",
  "score_io_phases",
  "score_blocks",
  "postings_decoded",
  "position_integers",
  "pair_membership_integers",
  "metadata_ms",
  "estimated_allocation_bytes",
];
const csv = (v: unknown) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
await writeFile(
  output + "/queries.csv",
  [
    columns,
    ...queries.map((q) => {
      const c = q.conditions["memory-reuse"].counters;
      return [
        q.brief_id,
        q.query_style,
        q.query,
        q.rewritten,
        q.resultCount,
        q.executor,
        q.conditions["cpu-no-delays"].cpuMs.p50,
        q.conditions["memory-reuse"].wallMs.p50,
        q.conditions["shared-warm-memory-empty"].wallMs.p50,
        c.scoreIOWaves ?? 0,
        c.scoreBlocksFetched ?? 0,
        c.scorePostingsDecoded ?? 0,
        c.positionIntegers ?? 0,
        c.pairMembershipIntegers ?? 0,
        c.metadataMs ?? 0,
        q.estimatedAllocationBytesPerCall,
      ];
    }),
  ]
    .map((row) => row.map(csv).join(","))
    .join("\n") + "\n",
);
console.log(
  JSON.stringify({ requests: summary.requests, aggregates }, null, 2),
);
for (const metric of [
  "cpu-no-delays",
  "memory-reuse",
  "shared-warm-memory-empty",
]) {
  console.log("TOP", metric);
  for (const q of queries
    .slice()
    .sort((a, b) =>
      metric === "cpu-no-delays"
        ? b.conditions[metric].cpuMs.p50 - a.conditions[metric].cpuMs.p50
        : b.conditions[metric].wallMs.p50 - a.conditions[metric].wallMs.p50,
    )
    .slice(0, 15))
    console.log(
      q.brief_id,
      q.resultCount,
      q.executor,
      JSON.stringify({
        cpu: q.conditions["cpu-no-delays"].cpuMs.p50,
        wall: q.conditions[metric].wallMs.p50,
        waves: q.conditions[metric].counters.scoreIOWaves,
        metadata: q.conditions[metric].counters.metadataMs,
      }),
      q.query,
    );
}
