# Ingestion CPU

The optimized constructor used 37.0% less Cloudflare CPU in a randomized,
interleaved comparison of 40 requests. Each request ingested 512 documents from
one of four ranges within the first million court cases. Each range/variant had
five observations. Expanded sorted posting bytes, document bounds, and field
totals matched exactly on every request. These are ingestion measurements,
including compression and writes, not timings for the whole build.

| First document | Tokens per request | Control median CPU | Optimized median CPU | Reduction |
|---|---:|---:|---:|---:|
| 0 | 670,675 | 3,755 ms | 3,055 ms | 18.6% |
| 100,000 | 488,776 | 4,402 ms | 1,945 ms | 55.8% |
| 500,000 | 227,568 | 1,829 ms | 1,130 ms | 38.2% |
| 900,000 | 593,262 | 3,615 ms | 2,229 ms | 38.3% |

Total CPU across the 20 requests per variant fell from 72,380 to 45,603 ms.
Cloudflare CPU and wall observations are joined by CF-Ray. Median client latency
improved in all four ranges, but includes uncontrolled R2 and network behavior.
Five observations per range do not establish production percentiles or the
average improvement over the corpus. The bootstrap 95% interval for the measured
CPU reduction is 25.5–47.6%; it does not capture systematic host differences
or temporal variation.

## Changes

- Cache pure Porter2 stemming results within each ingestion request. The cache
  has a 2 MiB accounting budget and at most 16,384 entries; keys and values are
  detached from source strings. About 94–96% of tokens hit this cache in the four
  measured ranges. This does not change normalization or stemming.
- Scan normalized words and token ordinals without calculating display spans.
  Ingestion does not use those spans. Packaging still uses its existing analysis.
- Write compact staging bytes into a preallocated buffer, rather than accumulating
  a JavaScript number array and converting it. Reuse one DataView per input block.
- Build each posting row in one allocation, share the empty position encoding,
  and accumulate occurrence counts while recording positions instead of parsing
  the encoded rows again to generate summaries.

The staging and serving bytes retain their existing formats. Matching, scoring,
context, and excerpts are unchanged. Unicode and cache-eviction tests compare the
new scanner against both the existing span scanner and the query tokenizer.
`yarn run check`, formatting checks, and all 322 tests in 87 files passed.

An earlier version with only the analysis changes used 29.1% less total CPU over
80 requests, but the 100,000 range regressed by 6.3% in median CPU. Its full report
is retained as `cpu/analysis.json`. The final version improved all four ranges in
the subsequent comparison. Because those are different sessions, this does not
isolate the allocation changes' effect from host variation.

## Allocation and remaining work

Local workerd allocation sampling on the same first 512 documents estimated
649.8 MiB cumulatively allocated by the control and 305.4 MiB by the optimized
code, a 53.0% reduction. These are sampling estimates, not retained memory or
Cloudflare peaks. Maximum observed heap fell from 54.8 to 41.8 MiB; backing
storage rose from 15.9 to 18.9 MiB. Sampling can miss the instantaneous peak.
Forced garbage collection was unavailable, so retained memory after collection
is not reported. R2 storage runs outside the measured application isolate.

The local baseline attributed about a quarter of sampled time to stemming and
its helpers. In the optimized profile, compression/decompression, token scanning,
DataView creation, and garbage collection remain substantial. A useful next CPU
experiment is writing packed positions directly into posting rows, avoiding the
remaining temporary position buffers. It must preserve the byte encoding and be
measured against this version. Lower compression effort is another experiment,
but could increase transfers enough to make elapsed time worse.

That position-writing experiment is now implemented and measured in
[CONSTRUCTION-POSITIONS.md](CONSTRUCTION-POSITIONS.md), including its remaining
CPU regression and uncertainty.

Increasing the number of independent ingestion requests can increase throughput;
it does not reduce CPU per document. The current 1M run uses eight requests at
most across all phases and completed ingestion in 29m26s. It retains its original
Worker code so CPU experiments do not change that build midway. It stopped on a
temporary 503 during a coordinator download; download retries were added and the
same build resumed using completed tasks. The original coordinator and manifest
are retained, with the reason for that repair recorded in the manifest.

## Reproduction

Use an isolated compiled control and a separate fresh-construction deployment:

```sh
yarn node --import tsx bench/columnar/deploy-compiled-construction.ts CONTROL_DEPLOYMENT ISOLATED_CONTROL_NAME
CWS_INGEST_COUNT=512 CWS_INGEST_REPETITIONS=5 yarn node --import tsx bench/columnar/construction-ingest-cpu.ts CONTROL_URL OPTIMIZED_URL OUTPUT
yarn node --import tsx bench/columnar/construction-ingest-cpu-report.ts OUTPUT/results.json CONTROL_TAIL OPTIMIZED_TAIL OUTPUT/with-cpu.json
```

Use Wrangler JSON tails during the comparison. Verification downloads are
reported separately and excluded from ingestion latency. Source identities,
deployment code hashes, randomization seed, request counts, decoded hashes, I/O,
native CPU/wall time and bootstrap settings are in
`bench/results/columnar/construction-v3/cpu/allocations.json`.

`construction-memory.ts COMPLETED_INDEX DEPLOYMENT OUTPUT` profiles local workerd;
set `CWS_ORACLE_URL` to the isolated source oracle and `CWS_PROFILE_INGEST_ONLY=1`
for the ingestion comparison. `construction-memory-report.ts` summarizes heap,
backing storage and estimated allocation separately. `construction-profile-report.ts`
reads the compressed CPU profiles. Profiles are diagnostic and do not establish
native CPU attribution.
