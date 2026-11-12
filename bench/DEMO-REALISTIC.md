# Realistic demo benchmark

Measured 2026-11-12T04:30:54.239023+00:00. The benchmark pins **2,866,398 official-snapshot opinions across 67 immutable partitions**, each with the production 8-MiB bundled-index budget. Later imports are excluded. It exercises production gateway/shard code, exact global BM25, top-20 results, legal case details, term-aware excerpts, and HMAC-signed pagination. No search optimization is introduced by this benchmark.

## Findings

The 20-ms fixed-read model is optimistic. Native Worker→R2 observations show substantial variation and cache/locality sensitivity. Search response time includes a result-assembly phase after ranking; this phase issues document, case-catalog, case-record, content-catalog and compressed-opinion reads. It remains expensive when postings are warm.

Every measured local response matched the frozen deployment's ranked IDs and scores (relative tolerance 1e-11). The local benchmark executes the actual 67-index graph, not a single sampled shard, and disallows remote cache fills during timed runs.

### Matched final warmed pass (16 distinct scenarios)

|Execution/profile|Queries|P50 seconds|Sample P95 seconds|
|---|---:|---:|---:|
|Actual deployed Workers, final pass|16|1.61|3.32|
|Local filesystem / no added R2 wait|16|0.05|0.60|
|Local old 20-ms fixed R2 delay|16|0.58|1.36|
|Local measured repeated-range R2 profile|16|1.48|3.73|
|Local measured varied-range R2 profile|16|2.74|6.82|

The repeated-range and varied-range profiles are sensitivity bounds, not an inferred traffic mix. R2 itself cannot be explicitly flushed by these probes. Equal weighting of 16 legal scenarios is coverage, not a claim about user-query popularity. Sample P95 is the largest observation for n=16; do not interpret it as a reliable service SLO.

|Live observed pass|Queries|P50 seconds|Sample P95 seconds|
|---|---:|---:|---:|
|0|16|3.61|9.73|
|1|16|1.89|5.20|
|2|16|1.61|3.32|

Pass zero is first observed by this benchmark, not guaranteed cold: its leaf Workers are the live demo's existing leaves, and may already have cached data. The local `reset` scenario clears all application LRUs in the loaded graph before every query; `mixed` keeps them across a first sweep; `repeat` adds two more identical sweeps. No phase is claimed to force cold isolates, R2 caches, DNS or connections.

## Corpus characteristics

Exact corpus mean: 1,729.1 body tokens. A partition-stratified sample of 136,823 documents, weighted by partition population, has P50/P95/P99 810/6,413/11,983 tokens and sample maximum 116,060. This is a sampled maximum, not the corpus maximum. Original indexed title lengths are zero in 4.18% of weighted samples; display-caption repairs do not rebuild historical title postings.

The previous 100k real-corpus benchmark had body-token median 855, P95 6,983 and mean 1,874.3. Document lengths were broadly similar. The major missing features were the larger fanout, global-statistics scoring path and full result hydration. The frozen subset follows source import order; it is not a representative random sample of all US case law.

## Measured R2 distribution

864 reads from the private Worker R2 binding at **BOS**, in three time windows; six sizes from 16 bytes to 1 MiB, repeated and varied ranges, and concurrency 1/6/12. Timings exclude the Mac→Worker network.

|Range cohort|Concurrent reads|Samples|Header P50 ms|Header P95 ms|Header max ms|
|---|---:|---:|---:|---:|---:|
|repeated-range|1|144|63|104|151|
|repeated-range|6|144|63|98|116|
|repeated-range|12|144|130|170|199|
|varied-range|1|144|104|152|253|
|varied-range|6|144|98|146|268|
|varied-range|12|144|148|237|333|

The simulator resamples **serial** header/body pairs by nearest logarithmic read size. It selects one measured time window per query and preserves header/body pairing, adds an explicit six-slot header queue shared by the entire service-binding graph, releases slots at headers, and streams body chunks. Body time scales by bytes within size strata; reads above 1 MiB extrapolate transfer time. It does not add a second bandwidth delay on top of measured transfer. Burst probes validate queueing sensitivity and are not sampled as intrinsic delays, avoiding double-counting queue wait.

Cloudflare documents that [R2 requests count toward the shared top-level six-connection limit](https://developers.cloudflare.com/workers/platform/limits/) and that [connections are released at response headers](https://developers.cloudflare.com/changelog/post/2026-04-09-relaxed-connection-limiting/). [Service bindings normally share a server/thread](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/); the local graph therefore runs on one Node event loop rather than pretending that all 67 shards have independent CPU cores. Actual placement remains a platform decision.

## Where the live time goes

Final observed pass, per-query phases in seconds. `Cards` starts when the final ranking arrives and includes concurrent metadata and excerpt work. Root R2 excludes leaf R2; it is not total system I/O.

|Query|Statistics|Rank ready|Cards|Full response|Root R2 reads|
|---|---:|---:|---:|---:|---:|
|`summary judgment`|0.03|0.66|0.96|1.62|40|
|`personal jurisdiction`|0.03|0.69|0.84|1.53|40|
|`breach fiduciary duty`|0.03|0.99|0.84|1.84|40|
|`arbitrary capricious agency`|0.03|0.86|0.79|1.65|40|
|`"clear and convincing evidence"`|0.03|2.43|0.89|3.32|40|
|`"res ipsa loquitur"`|0.58|2.28|0.92|3.20|40|
|`(standing OR mootness) AND jurisdiction`|0.03|0.10|0.90|1.00|40|
|`(copyright OR trademark) AND injunction`|0.20|0.85|0.80|1.65|40|
|`qualified AND immunity NOT prison`|0.04|0.69|0.84|1.53|40|
|`qualified /s immunity`|0.03|0.11|0.83|0.94|40|
|`contract /10 breach`|0.03|0.12|0.83|0.95|40|
|`notice /p termination`|0.03|0.79|0.82|1.61|40|
|`Christenberry Allen`|0.56|1.48|0.87|2.35|41|
|`Twombly Iqbal`|0.16|0.78|0.85|1.64|40|
|`court`|0.03|0.31|0.88|1.19|40|
|`unfindablebenchmarkzzzz`|0.58|0.61|0.00|0.61|0|

Root streamed-byte counts are bytes delivered to JavaScript; canceled excerpt streams may cause additional backend prefetch. Local counts include all simulated R2 calls and requested/consumed bytes by object kind. Neither figure is labeled as exact billed wire bytes.

## Prediction checks

These comparisons use the final pass of the same 16 queries. They test usefulness, not a promise of calibration across geographies or future workloads. No timings were fitted to force a three-second result.

|Local profile|Median absolute relative error|Median predicted/observed ratio|
|---|---:|---:|
|fixed20|63.7%|0.36×|
|empirical|90.6%|1.91×|
|empirical-repeated|8.1%|0.99×|

## Pagination and light load

Actual page-two requests: `summary judgment` 2.55s, `personal jurisdiction` 1.91s. The local benchmark validates both pages under fixed-delay, repeated-range and varied-range models using locally signed cursors. Only two distinct queries were paged, too few for meaningful tail quantiles.

|Deployed client concurrency|Queries|Elapsed seconds|Queries/sec|Client P50 seconds|Client sample P95 seconds|
|---|---:|---:|---:|---:|---:|
|1|16|28.38|0.56|1.62|3.24|
|4|16|6.78|2.36|1.46|3.14|

This is a short closed-loop burst, not sustained-load capacity or an open-loop arrival process. CPU in the JSON is aggregate local Node process CPU, including simulation/orchestration, not Cloudflare CPU. RSS holds 67 logical Workers and their bundles in one process; it is not per-isolate memory or a Workers memory-limit test. [Worker clocks do not measure synchronous CPU work](https://developers.cloudflare.com/workers/runtime-apis/performance/), so live phase timers are elapsed I/O-path observations rather than precise CPU profiling. Local bundle loading and corpus sampling happen before timing.

## Local resource and I/O samples

Final warmed sweep. CPU includes the local orchestrator and storage simulation; sampled RSS is the combined host process, not an isolate or a transient high-water mark.

|Local profile|Median process CPU ms|Maximum sampled RSS MiB|Median total R2 calls|Median requested KiB|
|---|---:|---:|---:|---:|
|none|62|1122|122|983|
|fixed20|80|671|122|972|
|empirical-repeated|264|1047|122|982|
|empirical|212|584|123|983|

## Best next experiments

1. **Reduce result-card round trips.** Store the opinion-body range pointer alongside returned document metadata: a warm 20-hit page currently makes 20 content-catalog reads plus 20 body reads at the root. Co-locating pointers can remove the first 20. Preserve overlap between metadata and excerpt retrieval: waiting for an entire metadata batch before starting snippets could offset the read savings. Pack legal case fields and useful excerpt data together, and measure first visible result separately from fully hydrated results. This does not require a learned workload or phrase accelerator.
2. **Restore global-score-safe skipping.** The production `globalStats` path disables streaming/WAND and local score bounds for correctness. Every local leaf diagnostic here reports `materialized`. Derive bounds that remain valid under global IDF/average lengths, then validate exact rankings with this harness.
3. **Reduce dictionary/statistics fanout for rare terms.** A generation-level global term directory/statistics page could replace repeated per-partition cold dictionary lookups and identify which partitions need searching. Preserve exact global DF and score comparability.
4. **Measure real traffic and geography.** Collect consent-appropriate aggregate query categories, cache hit/miss rates and multiple-colo latency samples before choosing traffic weights, cache policies or a production P95 target.

## Reproduce

```sh
# Uses the signed-in Wrangler account and existing full-import state.
node --import tsx bench/demo-setup.ts
node --import tsx bench/demo-capture.ts
node --import tsx bench/demo-latency.ts
node --max-old-space-size=4096 --import tsx bench/demo-local.ts --hydrate
node --max-old-space-size=4096 --import tsx bench/demo-pages.ts --hydrate

# Timed runs are offline; missing ranges fail rather than fetching the network.
DEMO_OUTPUT=local-final node --max-old-space-size=4096 --import tsx bench/demo-local.ts
DEMO_MODES=empirical-repeated DEMO_PHASES=repeat DEMO_OUTPUT=local-repeated-final \
  node --max-old-space-size=4096 --import tsx bench/demo-local.ts
node --max-old-space-size=4096 --import tsx bench/demo-pages.ts
node --import tsx bench/demo-load.ts
python3 bench/demo-report.py
```

The private benchmark root and routers point at frozen existing leaf generations; they do not duplicate R2 index objects or stop the import. Setup keeps `work/demo-bench/snapshot.json` when rerun. Use a new work directory/snapshot deliberately to compare a later corpus. Work directories, credentials and mirrored bytes are ignored by Git. Timed local runs require only the mirror, bundled indexes, calibration, captured responses and snapshot; they do not read Cloudflare credentials or perform HTTP requests. JSONL progress avoids repeatedly serializing the entire accumulated trace during measurements.

Machine-readable results: [results/demo-realistic.json](results/demo-realistic.json). Raw detailed traces and mirrors remain under ignored `work/demo-bench/`. Background import, one Mac, one observed colo, a small scenario suite, unknown R2 cache state, latency quantization and runtime differences limit external validity.
