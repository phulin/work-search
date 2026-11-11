import { readFile, writeFile } from "node:fs/promises";
const before = JSON.parse(
  await readFile("bench/baseline-v2/results/results.json", "utf8"),
);
const after = JSON.parse(await readFile("bench/results/results.json", "utf8"));
const original = JSON.parse(
  await readFile("bench/baseline-v1/results/results.json", "utf8"),
);
const paired = JSON.parse(await readFile("bench/results/paired.json", "utf8"));
const micro = JSON.parse(
  await readFile("bench/results/length-access.json", "utf8"),
);
const profile = JSON.parse(
  await readFile("bench/results/cpu-profile-summary.json", "utf8"),
);
const key = (r: any) => `${r.documents}-${r.budgetMiB}-${r.strategy}`;
const baseline = new Map(before.results.map((r: any) => [key(r), r]));
if (after.results.length !== before.results.length)
  throw new Error("Benchmark matrix is incomplete");
const comparisons = after.results.map((a: any) => {
  const b = baseline.get(key(a)) as any;
  if (a.status !== "ok" || b?.status !== "ok")
    throw new Error("Benchmark configuration failed");
  const binaryIdentical =
    a.bundleSha256 === b.bundleSha256 &&
    a.bundleBytes === b.bundleBytes &&
    a.budget === b.budget;
  const objectsIdentical =
    JSON.stringify(a.objects) === JSON.stringify(b.objects);
  const ioIdentical = ["avgRequests", "avgBytes", "zeroReadPercent"].every(
    (k) => a[k] === b[k],
  );
  if (!binaryIdentical || !objectsIdentical || !ioIdentical)
    throw new Error("Index or I/O changed: " + key(a));
  return {
    name: key(a),
    binaryIdentical,
    objectsIdentical,
    ioIdentical,
    before: b,
    after: a,
  };
});
const failures = after.results
  .flatMap((r: any) => r.samples ?? [])
  .filter((s: any) => s.error).length;
let report =
  "# Compressed-length access optimization\n\nThe previous compressed reader is preserved from commit 6799e3d in baseline-v2/, including raw matrix results and a frozen decoder used only for paired benchmarks. Production remains binary format v2: no index rebuild is required for an existing v2 deployment.\n\n## Changes and resource bounds\n\n- Cache the last 32-document block header in seven numeric scalars, so sorted scoring candidates reuse validated offsets, minima and widths. Public accesses still validate document IDs; block checksums and geometry remain validated before use.\n- Return minima directly for constant columns; decode varying packed lengths with byte/bit operations instead of an exponentiation loop. Unaligned fields spanning five bytes and all 0–32-bit widths are tested.\n- Reuse one caller-owned length-result object per search. Default public reads still return independent values; there is no decoded document array or per-block length cache.\n\nAll 24 regenerated index binaries have **identical SHA-256 hashes and byte lengths** to the original v2 builds. Remote object lists/hashes and average I/O are also identical. Budgets remain 8/16/32/48 MiB. The million-document document table remains 5.97 MiB (6.67 MiB with dictionary), and its validation bitmap remains 3,907 bytes. Only Worker code changes; its small code-size difference is captured by the Wrangler dry-run artifacts, within the existing code headroom.\n\n## Paired length-access microbenchmark\n\nOne million accesses per sample, twelve measured samples, baseline/optimized order alternated, medians shown. Both readers use the same bytes in one process with warmed validation and JIT. Checksums of all returned lengths are verified equal. The varying-length fixture uses body lengths 0–1023 and title lengths 0–8; it is additional to the constant-length synthetic corpus. The microbenchmark uses the default allocating API for both readers; the query-only result-object reuse is not needed to obtain these figures.\n\n|Lengths|Access|Before ms|After ms|Speedup|\n|---|---|---:|---:|---:|\n";
for (const r of micro.rows)
  report += `|${r.name}|${r.access}|${r.baselineMedianMs.toFixed(2)}|${r.optimizedMedianMs.toFixed(2)}|${(r.baselineMedianMs / r.optimizedMedianMs).toFixed(2)}×|\n`;
report +=
  "\n## CPU profile\n\nA V8 sampling profile repeats the same four query types twelve times on the same 48 MiB workload-aware index. Self-samples attributed to document-table functions fell from " +
  profile.profiles[0].documentSelfSamples +
  "/" +
  profile.profiles[0].totalSamples +
  " to " +
  profile.profiles[1].documentSelfSamples +
  "/" +
  profile.profiles[1].totalSamples +
  ". Inlining/JIT attribution makes these approximate, not exact function timers. Raw profiles are generated under ignored bench/generated/profiles/; the compact summary is checked in. Reproduce with:\n\n```sh\nmkdir -p bench/generated/profiles\nnode --cpu-prof --cpu-prof-dir=bench/generated/profiles --cpu-prof-name=before.cpuprofile --import tsx bench/profile.ts bench/generated/1000000-48-workload --baseline\nnode --cpu-prof --cpu-prof-dir=bench/generated/profiles --cpu-prof-name=after.cpuprofile --import tsx bench/profile.ts bench/generated/1000000-48-workload\nnpx tsx bench/profile-summary.ts\n```\n";
report +=
  "\n## Paired end-to-end comparison\n\nSame process, identical immutable v2 indexes, alternating execution order, one unmeasured warmup per query and ten measured passes over twelve queries (120 samples per reader/configuration). Only the document-table reader differs: the frozen reader ignores the optional scratch result and returns its original independent object. Full results, scores, exact totals, and I/O counters are checked equal for every pair. These warm Node HTTP-handler/filesystem measurements reduce between-run noise; they still exclude actual Cloudflare and public-network latency.\n\n|Million-doc configuration|Before P50 ms|After P50 ms|Before P95 ms|After P95 ms|P95 reduction|Before CPU ms/query|After CPU ms/query|\n|---|---:|---:|---:|---:|---:|---:|---:|\n";
for (const r of paired.rows)
  report += `|${r.name}|${r.baselineP50Ms.toFixed(2)}|${r.optimizedP50Ms.toFixed(2)}|${r.baselineP95Ms.toFixed(2)}|${r.optimizedP95Ms.toFixed(2)}|${(100 * (1 - r.optimizedP95Ms / r.baselineP95Ms)).toFixed(1)}%|${r.baselineCpuMs.toFixed(2)}|${r.optimizedCpuMs.toFixed(2)}|\n`;
report +=
  "\n## Complete rebuilt matrix\n\nColumns show previous v2 → optimized v2, with the same corpus seed, queries, three passes, top 20 and ID-only AND mode. These are separate runs, so timing differences also include scheduling, GC and host load; the paired measurements above are the stronger attribution check. Build timings and offline peak RSS are preserved in the raw data, but this reader-only change is not intended to improve the builder.\n\n|Docs|Budget MiB|Policy|P50 ms|P95 ms|CPU ms/query|Zero reads % (unchanged)|Reads/query (unchanged)|\n|---:|---:|---|---:|---:|---:|---:|---:|\n";
for (const { before: b, after: a } of comparisons)
  report += `|${a.documents}|${a.budgetMiB}|${a.strategy}|${b.p50Ms.toFixed(2)} → ${a.p50Ms.toFixed(2)}|${b.p95Ms.toFixed(2)} → ${a.p95Ms.toFixed(2)}|${b.avgCpuMs.toFixed(2)} → ${a.avgCpuMs.toFixed(2)}|${a.zeroReadPercent.toFixed(1)}|${a.avgRequests.toFixed(2)}|\n`;
report +=
  "\n## Original regression at 48 MiB\n\n|Policy|Uncompressed v1 P95 ms|Original compressed v2 P95 ms|Optimized compressed v2 P95 ms|\n|---|---:|---:|---:|\n";
for (const strategy of ["smallest", "workload"]) {
  const pick = (x: any) =>
    x.results.find(
      (r: any) =>
        r.documents === 1000000 &&
        r.budgetMiB === 48 &&
        r.strategy === strategy,
    );
  report += `|${strategy}|${pick(original).p95Ms.toFixed(2)}|${pick(before).p95Ms.toFixed(2)}|${pick(after).p95Ms.toFixed(2)}|\n`;
}
report += `\nMeasured query failures: ${failures}. The workload-aware policy remains evaluated on its training queries and is optimistic. The fixed twelve-query synthetic suite has limited tail-latency confidence; no real-world corpus or deployed Cloudflare account was used. See WORKERD.md for actual local Worker HTTP/startup results, results/paired.json and results/length-access.json for paired samples, results/optimization.json for artifact invariance checks, and results/bundle-dry-run.txt for the largest Worker artifact.\n`;
await writeFile("bench/OPTIMIZATION.md", report);
await writeFile(
  "bench/results/optimization.json",
  JSON.stringify(
    {
      beforeEnvironment: before.environment,
      afterEnvironment: after.environment,
      artifactChecks: comparisons.map(({ before, after, ...r }: any) => r),
      comparisons: comparisons.map(({ name, before: b, after: a }: any) => ({
        name,
        before: { p50Ms: b.p50Ms, p95Ms: b.p95Ms, avgCpuMs: b.avgCpuMs },
        after: { p50Ms: a.p50Ms, p95Ms: a.p95Ms, avgCpuMs: a.avgCpuMs },
      })),
    },
    null,
    2,
  ),
);
