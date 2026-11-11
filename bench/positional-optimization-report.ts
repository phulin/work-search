import { readFile, writeFile } from "node:fs/promises";
const before = JSON.parse(
  await readFile("bench/baseline-v3/results/results.json", "utf8"),
);
const after = JSON.parse(await readFile("bench/results/results.json", "utf8"));
const paired = JSON.parse(
  await readFile("bench/results/paired-connectors.json", "utf8"),
);
const name = (r: any) => `${r.documents}-${r.budgetMiB}-${r.strategy}`;
const base = new Map(before.results.map((r: any) => [name(r), r]));
if (before.results.length !== after.results.length)
  throw new Error("Incomplete matrix");
const checks = after.results.map((r: any) => {
  const b = base.get(name(r)) as any;
  if (!b || r.status !== "ok") throw new Error("Missing/failed configuration");
  const equal =
    r.bundleSha256 === b.bundleSha256 &&
    r.bundleBytes === b.bundleBytes &&
    r.budget === b.budget &&
    JSON.stringify(r.objects) === JSON.stringify(b.objects);
  if (!equal) throw new Error("Index changed: " + name(r));
  for (const group of ["samples", "connectorSamples"]) {
    if (r[group].length !== b[group].length)
      throw new Error("Workload changed");
    for (let i = 0; i < r[group].length; i++) {
      const x = r[group][i],
        y = b[group][i];
      for (const k of [
        "q",
        "total",
        "indexRequests",
        "indexBytes",
        "metadataRequests",
        "metadataBytes",
        "fullyLocal",
      ])
        if (x[k] !== y[k] || x.error)
          throw new Error("Result count/I/O differs: " + name(r) + " " + x.q);
    }
  }
  return {
    name: name(r),
    identicalIndexAndObjects: true,
    identicalMatchCountsAndIO: true,
  };
});
const metrics = (r: any) => {
  const good = r.connectorSamples.filter((s: any) => !s.error),
    lat = good.map((s: any) => s.ms).sort((a: number, b: number) => a - b);
  return {
    p50: lat[Math.ceil(lat.length * 0.5) - 1],
    p95: lat[Math.ceil(lat.length * 0.95) - 1],
    cpu: good.reduce((s: number, x: any) => s + x.cpuMs, 0) / good.length,
  };
};
let report =
  "# Phrase and proximity execution optimization\n\nThe original v3 matcher and search engine are frozen from a68426a in baseline-v3/, together with the original raw measurements. The index format remains v3; **no index rebuild is required** to deploy this optimization. All 24 index bundles and R2 object lists have identical byte sizes and SHA-256 hashes. Budgets, embedding decisions, exact match counts and I/O remain unchanged.\n\n## Execution changes\n\n- Compile the query into query-local plans once. Numeric epoch stamps replace per-candidate Map clears and repeated AST/string lookups.\n- Reuse bounded per-term body/title position buffers. Positions are read from validated immutable bytes, with a one-byte varint fast path; sparse candidates use galloping/binary document seeking. There is no corpus-wide expanded position cache.\n- Phrase existence uses the shortest position list as its anchor, advancing monotone cursors across the other words and stopping at the first match. Repeated words retain their distinct phrase offsets.\n- Proximity existence uses ordered interval sweeps; nonmonotone nested interval ends use lower-bound searches. Nested expressions retain every needed match, using windowed joins rather than all Cartesian pairs. Sorted OR spans are merged and deduplicated.\n- Materialize compound spans only when a parent needs locations. Cheap Boolean/exclusion filters run before expensive positional predicates when safe. Exact totals are still computed by examining the complete candidate set.\n\nEvery access retains bounds/corruption validation from decodePostings. Scratch is per query, within the existing 56 MiB working-set cap and bundle-dependent guard. Per-term retained body/title peaks plus growth are charged conservatively. Each materialized compound buffer is capped at 4,096 spans and query-wide retained compound capacity at 32,768 spans; the ten-million comparison/check budget remains. Dense simple phrases/proximity can now succeed without expanding thousands of span objects. Genuine resource exhaustion returns 503, never truncated matches.\n\n## Complete matrix, connector suite\n\nSame seed-42 corpora, seven connector queries × three passes, all 8/16/32/48 MiB budgets and both policies. Indexes were **reused and byte-verified**, because this is an execution-only change. All query timing/CPU/RSS measurements are fresh child-process measurements. Index construction timing/throughput/RSS are inherited from the original v3 builds and are explicitly not remeasured. New query-only process peak RSS must not be compared directly to old combined build+query process peak RSS. No runtime memory reduction is inferred from that difference.\n\nThese are local Node HTTP-handler/filesystem measurements, not deployed Cloudflare latency. Separate runs can be affected by host load, JIT and GC; paired measurements follow.\n\n|Docs|Budget MiB|Policy|Before P50 ms|After P50 ms|Before P95 ms|After P95 ms|Speedup P95|Before CPU ms/query|After CPU ms/query|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|\n";
const rows = [];
for (const r of after.results) {
  const b = base.get(name(r)) as any,
    old = metrics(b),
    current = metrics(r);
  rows.push({ name: name(r), before: old, after: current });
  report += `|${r.documents}|${r.budgetMiB}|${r.strategy}|${old.p50.toFixed(2)}|${current.p50.toFixed(2)}|${old.p95.toFixed(2)}|${current.p95.toFixed(2)}|${(old.p95 / current.p95).toFixed(2)}×|${old.cpu.toFixed(2)}|${current.cpu.toFixed(2)}|\n`;
}
report +=
  "\n## Paired million-document comparison\n\nSame process and immutable bytes, alternating execution order, one unmeasured warmup per query and five measured passes (35 samples per variant/configuration). Exact result IDs, scores, total counts and index/metadata I/O are checked equal for every pair.\n\n|Configuration|Before P95 ms|After P95 ms|Speedup|\n|---|---:|---:|---:|\n";
for (const r of paired.rows)
  report += `|${r.name}|${r.beforeP95Ms.toFixed(2)}|${r.afterP95Ms.toFixed(2)}|${(r.beforeP95Ms / r.afterP95Ms).toFixed(2)}×|\n`;
report +=
  "\n## Profiling\n\nV8 CPU profiles use the same 48 MiB workload-aware index and four passes over three common positional queries. The original profile showed substantial typed-array allocation in postingPositions. Reproduce the profiles with `node --cpu-prof --cpu-prof-dir=bench/generated/profiles --cpu-prof-name=connectors-before.cpuprofile --import tsx bench/profile-connectors.ts --baseline` and the corresponding `connectors-after.cpuprofile` command without `--baseline`, then run `node --import tsx bench/profile-positional-summary.ts`. Compact self-sample data is in results/positional-profile.json. Inlining, JIT and GC affect attribution; these are not precise function timers. Raw profiles remain under ignored bench/generated/profiles/.\n\n## Reproduction\n\n```sh\nnpm test\n# Regenerate identical corpora/indexes if bench/generated is absent:\nnpm run bench\n# Rerun query execution against existing verified indexes:\nnpm run bench -- --reuse-indexes\nnode --import tsx bench/paired-connectors.ts\nnode --import tsx bench/runtime.ts\nnode --import tsx bench/bundle.ts\nnode --import tsx bench/positional-optimization-report.ts\n```\n\nReuse mode requires the default configurations and a68426a baseline measurements in baseline-v3/. For custom corpora/configurations, use a fresh build. Raw current samples are in results/results.json and results/paired-connectors.json; artifact/count/I/O invariance checks are in results/positional-optimization.json. Local workerd HTTP/startup results are in WORKERD.md; the actual largest Worker artifact is recorded in results/bundle-dry-run.txt.\n\nThe suite is small and synthetic, and workload-aware embedding is still trained on the original plain-term workload. Connector queries are not part of that training. Tail percentiles have limited statistical confidence; broad queries still exhaustively score many candidates, and uncommon nested conjunctions may hit bounded span expansion. No Cloudflare deployment or production latency/memory measurements were performed.\n";
await writeFile("bench/POSITIONAL-OPTIMIZATION.md", report);
await writeFile(
  "bench/results/positional-optimization.json",
  JSON.stringify(
    {
      baselineEnvironment: before.environment,
      currentEnvironment: after.environment,
      checks,
      rows,
    },
    null,
    2,
  ),
);
