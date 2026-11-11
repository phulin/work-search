# Free Law Project: 100,000 decisions

## Corpus and workload
Expanded the pinned [COLD Cases](https://huggingface.co/datasets/harvard-lil/cold-cases) CourtListener/Free Law Project sample to 100,000 untruncated decisions (1,180,857,896 JSONL bytes). Source revision `5d8d0d8457ef63b6463af9737da21d3badd924ad`, seed `20261111`, all 32 source shards. All 10,000 original sampled decisions are retained. One document concatenates all opinions within a decision. SHA-256: `e621b2654ab99a61b8f558dd912193002594de4086d8e1d560324637ef14fb06`.

The source grouping and two-stage sampling limitations remain: one probability-proportional-to-size row group per shard, then uniform eligible rows within that group, shard quotas by total row count, deterministic final shuffle. This is clustered sampling, not an independent uniform sample of all US decisions. Shard checkpoints permit resuming without retaining full texts in RAM. Source locations, selected IDs, seed and corpus hash are recorded in the committed manifest; full texts/indexes stay in ignored generated files.

The original 64 embedding-training strings and 160 evaluation strings are unchanged. The Boolean/WAND supplement keeps the same 21 tuning OR strings and 40 separate OR strings: 221 evaluation queries total. No new tuning is performed for the larger corpus. Both embedding strategies see only the original training workload. Queries are artificial legal stress queries, not user logs or relevance judgments.

|Measure|Min|P50|P95|Max|Mean|Total|
|---|---|---|---|---|---|---|
|Body tokens|1|855|6983|171442|1874.25|187425411|
|Title tokens|1|4|11|598|5.57|556941|

## All four budgets: feasibility

|Budget MiB|Policy|Outcome|Mandatory bytes|Actual bundle MiB|Vocabulary|
|---|---|---|---|---|---|
|8|frequency|infeasible|31661566|n/a|632909|
|8|mixed|infeasible|31661566|n/a|632909|
|16|frequency|infeasible|31661566|n/a|632909|
|16|mixed|infeasible|31661566|n/a|632909|
|32|frequency|measured|31661566|32.00|632909|
|32|mixed|measured|31661566|32.00|632909|
|48|frequency|measured|31661566|48.00|632909|
|48|mixed|measured|31661566|48.00|632909|

Infeasible budgets have no latency, zero-read rate or Worker startup measurement. A dictionary/table allocation that exceeds the budget is not represented as a zero-latency result. The sample is never truncated to fit, and no remote dictionary or larger budget is substituted. Raw build/repacking failures are in the build record.

Full JSONL ingestion: 132.72 seconds (753.4 decisions/second), peak builder-process RSS reported as 1,269,121,024 bytes. Dictionary: 30,122,328 bytes; document tables: 1,539,238; frequencies: 90,981,544; positions: 290,330,886. Subsequent variants are offline stream repacks, not additional ingestion-throughput measurements.

## Latest system: latency and R2 simulation
All runs are local. Uncached means no retained SearchRuntime, while OS/file/validation caches may already be warm. Mixed-cache measurements use shuffled traffic through one 4 MiB cache per variant, reporting passes 1–2. Variants are paired in randomized order on identical v8 bytes. Correctness checks, JSON hashing and memory sampling are outside the timer. Each feasible configuration has 6,630 timed searches across five controls, plus 221 exhaustive reference searches. Failed queries are counted and excluded from successful latency quantiles.

### uncached
|MiB|Policy|Auto P50 ms|Auto P95 ms|Zero index reads %|Index reads/query|Index bytes/query|Errors|
|---|---|---|---|---|---|---|---|
|32|frequency|7.17|49.28|7.69|3.60|1038874|0|
|32|mixed|7.29|50.43|5.88|3.80|1049157|0|
|48|frequency|7.09|49.25|14.03|3.02|984174|0|
|48|mixed|7.16|50.37|14.03|2.91|925336|0|

### mixed-cache
|MiB|Policy|Auto P50 ms|Auto P95 ms|Zero index reads %|Index reads/query|Index bytes/query|Errors|
|---|---|---|---|---|---|---|---|
|32|frequency|7.61|54.86|9.28|3.47|1025542|0|
|32|mixed|7.39|55.75|7.24|3.67|1035658|0|
|48|frequency|7.43|54.22|15.61|2.92|973108|0|
|48|mixed|7.64|53.00|15.38|2.81|914394|0|

## Query type detail: mixed embedding

|MiB|Type|Cache mode|P50 ms|P95 ms|Zero reads %|Reads/query|Bytes/query|Errors|
|---|---|---|---|---|---|---|---|---|
|32|plain|uncached|3.92|15.40|7.50|1.82|103016|0|
|32|plain|mixed-cache|4.63|17.49|8.75|1.75|99142|0|
|32|phrase|uncached|7.85|54.21|0.00|6.95|3225424|0|
|32|phrase|mixed-cache|6.66|55.75|0.00|6.85|3194760|0|
|32|proximity|uncached|6.83|39.91|2.50|3.67|2074456|0|
|32|proximity|mixed-cache|6.79|41.70|2.50|3.61|2049498|0|
|32|boolean|uncached|9.58|23.53|17.50|2.00|122907|0|
|32|boolean|mixed-cache|10.04|28.95|17.50|2.00|122907|0|
|32|wand-or|uncached|16.78|66.00|4.76|2.67|200421|0|
|32|wand-or|mixed-cache|19.02|60.60|9.52|2.57|195066|0|
|32|wand-heldout|uncached|11.72|59.26|2.50|5.15|165567|0|
|32|wand-heldout|mixed-cache|13.40|67.41|6.25|4.69|153291|0|
|48|plain|uncached|3.85|15.27|25.00|1.12|24078|0|
|48|plain|mixed-cache|4.53|18.36|26.25|1.06|22616|0|
|48|phrase|uncached|6.38|53.75|0.00|5.50|3000395|0|
|48|phrase|mixed-cache|6.66|56.52|0.00|5.45|2976709|0|
|48|proximity|uncached|6.33|40.01|5.00|2.92|1849621|0|
|48|proximity|mixed-cache|6.77|41.83|5.00|2.89|1826709|0|
|48|boolean|uncached|9.55|23.33|25.00|1.45|57852|0|
|48|boolean|mixed-cache|10.25|28.79|25.00|1.45|57852|0|
|48|wand-or|uncached|16.77|57.33|33.33|1.48|88063|0|
|48|wand-or|mixed-cache|18.93|61.17|33.33|1.43|84332|0|
|48|wand-heldout|uncached|11.09|59.71|5.00|4.33|134300|0|
|48|wand-heldout|mixed-cache|12.55|68.26|11.25|3.92|123865|0|

## Execution controls at scale

|MiB|Type|Cache mode|Executor|P50 ms|P95 ms|
|---|---|---|---|---|---|
|32|boolean|uncached|before|19.00|27.48|
|32|boolean|uncached|recovered|9.57|23.02|
|32|boolean|uncached|tree|10.40|23.78|
|32|boolean|uncached|wand|7.49|14.99|
|32|boolean|uncached|auto|9.58|23.53|
|32|boolean|mixed-cache|before|19.28|27.82|
|32|boolean|mixed-cache|recovered|10.05|28.34|
|32|boolean|mixed-cache|tree|12.02|28.76|
|32|boolean|mixed-cache|wand|7.89|16.82|
|32|boolean|mixed-cache|auto|10.04|28.95|
|32|wand-heldout|uncached|before|25.93|89.39|
|32|wand-heldout|uncached|recovered|17.76|72.22|
|32|wand-heldout|uncached|tree|20.94|80.71|
|32|wand-heldout|uncached|wand|11.95|60.46|
|32|wand-heldout|uncached|auto|11.72|59.26|
|32|wand-heldout|mixed-cache|before|26.95|92.10|
|32|wand-heldout|mixed-cache|recovered|18.84|76.92|
|32|wand-heldout|mixed-cache|tree|24.07|92.48|
|32|wand-heldout|mixed-cache|wand|13.15|67.18|
|32|wand-heldout|mixed-cache|auto|13.40|67.41|
|48|boolean|uncached|before|18.99|27.65|
|48|boolean|uncached|recovered|9.60|22.63|
|48|boolean|uncached|tree|10.42|23.64|
|48|boolean|uncached|wand|7.64|17.48|
|48|boolean|uncached|auto|9.55|23.33|
|48|boolean|mixed-cache|before|20.25|27.76|
|48|boolean|mixed-cache|recovered|9.91|28.59|
|48|boolean|mixed-cache|tree|12.13|29.06|
|48|boolean|mixed-cache|wand|7.84|17.77|
|48|boolean|mixed-cache|auto|10.25|28.79|
|48|wand-heldout|uncached|before|26.07|89.90|
|48|wand-heldout|uncached|recovered|17.83|71.80|
|48|wand-heldout|uncached|tree|21.02|80.51|
|48|wand-heldout|uncached|wand|11.72|60.93|
|48|wand-heldout|uncached|auto|11.09|59.71|
|48|wand-heldout|mixed-cache|before|24.89|91.98|
|48|wand-heldout|mixed-cache|recovered|18.42|75.80|
|48|wand-heldout|mixed-cache|tree|24.02|95.31|
|48|wand-heldout|mixed-cache|wand|12.85|67.67|
|48|wand-heldout|mixed-cache|auto|12.55|68.26|

Before freezes the previous block executor; recovered disables WAND for supplemental/held-out OR queries; tree and wand force their eligible executors; auto is the latest default. Field-aware bounds, scores and deterministic ties remain exact. Raw records include CPU, decoded blocks, pivot/seek diagnostics, request/byte counts, cache retention, RSS and heap observations. Host RSS includes reference/index buffers and multiple cache contexts; it is not isolate memory.

## Worker packaging
|MiB index|Wrangler total upload KiB|Gzip KiB (reference only)|
|---|---|---|
|32|32860.99|16316.55|
|48|49245.00|29996.10|

Both feasible binary fixtures pass Wrangler dry-run packaging with the current Worker code. [Current Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) checked November 11, 2026 allow 64 MiB uncompressed Worker size; gzip is not the size limit. These bundles are below that size ceiling. Account deployment, startup CPU and production isolate-memory safety are not established by a dry run.

## Comparison with the 10,000-decision run
Same engine, query strings and control structure; different sample size/corpus statistics. Configurations are not interleaved across corpus sizes, so host/JIT/GC/thermal differences can affect absolute scaling ratios.

|MiB|Cache mode|P50 ms 10k → 100k|P95 ms 10k → 100k|Zero reads % 10k → 100k|Reads/query 10k → 100k|
|---|---|---|---|---|---|
|32|uncached|0.87 → 7.29|5.28 → 50.43|61.09 → 5.88|0.68 → 3.80|
|32|mixed-cache|0.82 → 7.39|5.24 → 55.75|71.27 → 7.24|0.50 → 3.67|
|48|uncached|0.82 → 7.16|5.05 → 50.37|100.00 → 14.03|0.00 → 2.91|
|48|mixed-cache|0.71 → 7.64|4.56 → 53.00|100.00 → 15.38|0.00 → 2.81|

## Actual local Worker

|MiB, mixed|HTTP responses|P50 ms|P95 ms|Process startup wall ms|Routes exercised|
|---|---|---|---|---|---|
|32|39|9.12|80.55|233.98|{'wand': 9, 'boolean-blocks': 6, 'materialized': 24}|
|48|39|8.32|96.16|96.93|{'wand': 9, 'boolean-blocks': 6, 'materialized': 24}|

Wrangler-built code runs in actual local workerd with Miniflare R2 bindings. Every timed response is checked against exhaustive Node results with 1e-12 cross-runtime score tolerance, and extra untimed requests compare every timed result and fresh default results exactly against exhaustive scores inside workerd. Assertions require WAND and Boolean-block routes to be exercised before cache warmup. Startup includes local process creation/IPC. No deployed Cloudflare/R2 latency, account-limit validation or concurrent-load result is claimed.

## Reproduction
```sh
uv venv --python 3.12 work/flp-venv
uv pip install --python work/flp-venv/bin/python -r bench/flp-requirements.txt
work/flp-venv/bin/python bench/sample-flp.py --count 100000 --out bench/generated/flp-100000
export FLP_ROOT=bench/generated/flp-100000
export FLP_PREFIX=flp100k
export FLP_QUERY_SOURCE=bench/results/flp-queries.json
node --import tsx bench/flp-prepare.ts
node --import tsx bench/flp-build.ts
node --import tsx bench/boolean-run.ts
node --import tsx bench/boolean-worker.ts
node --import tsx bench/flp-bundle.ts
python3 bench/flp-scale-report.py
```
Source generations are immutable; use a fresh source output for a fresh build, or `flp-build.ts --reuse-source` after a completed verified build to repeat offline repacks. Sampling checkpoints are hash-checked and scoped by revision/count/seed. The 10k corpus and its reports are not overwritten. Main limits remain artificial query weights, clustered sampling, local storage latency, whole-stream cold frequency fetches in WAND, and unmeasured concurrent isolate memory.
