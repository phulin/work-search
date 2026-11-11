# Free Law Project real-text corpus benchmark

## Corpus and provenance
10,000 full-text decisions sampled from [COLD Cases](https://huggingface.co/datasets/harvard-lil/cold-cases), Harvard Library Innovation Lab’s CourtListener repackaging prepared with Free Law Project, linked from [FLP’s bulk data documentation](https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data). Dataset revision `5d8d0d8457ef63b6463af9737da21d3badd924ad`, seed `20261111`; source inventory has 8,362,176 rows across 32 shards. Source license is CC0-1.0.

The sampler allocates decisions by shard size, chooses one row group per shard with probability proportional to row count, then samples eligible distinct decisions uniformly within that group. This is a stratified two-stage cluster sample, not an independent uniform sample of the full dataset. Source grouping can induce correlations. Empty texts and duplicate cluster IDs are excluded; no length cutoff or text truncation is applied. All opinions belonging to a decision are concatenated with two newlines; one engine document represents one decision. Final serving order is deterministically shuffled.

Corpus JSONL: 115,240,107 bytes, SHA-256 `79cb3eb011b33aa2110c54223657771f13b99d3091eee9a675ec2b2b94b895f0`. The ignored local corpus is `bench/generated/flp/corpus.jsonl`; the committed sample manifest records every source file, row group, row and cluster ID.

|Measure|Min|P50|P95|Max|Mean|Total|
|---|---|---|---|---|---|---|
|Body tokens|1|832|6893|59239|1831.91|18319069|
|Title tokens|1|4|11|255|5.51|55100|

Court-type and filing-decade distributions are in results/flp-corpus-stats.json. This sample measures real textual variation, not complete coverage of US law.

## Findings
The real sample exposes costs hidden by the uniform synthetic corpus: 145,185 dictionary terms and 7,009,789 mandatory bundled bytes for only 10,000 decisions. Every budget fits, but 8 MiB leaves limited posting space. All 15,360 timed Node searches and 192 local Worker HTTP requests succeed after the mixed-block decoder fix.

The new executor is not a universal win: plain, phrase and proximity uncached medians improve in the paired runs, but the current positive Boolean block iterator regresses on this workload. At 8 MiB with mixed embedding, Boolean mixed-cache median is about 0.87 → 1.98 ms; at 48 MiB it is about 3.67 → 8.50 ms. This is a concrete target for adaptive executor selection, not evidence that the real corpus is unsuitable. No tuning was applied to remove that regression from these results.

## Workload and timing
64 training strings and 160 disjoint evaluation strings, balanced across plain terms, exact phrases, /n proximity and Boolean groups. They combine hand-authored legal terms with deterministically selected phrases/terms from sampled decisions. They are artificial stress queries, not attorney query logs; corpus-derived queries favor queries with matches. Shared terms between training/evaluation are intentional, but exact query strings are disjoint. Both embedding strategies see only the training strings.

Each index runs stages 0 (previous execution behavior) and 7 (new execution behavior) on the exact same v8 bytes. This isolates execution, not the encoding change. Each variant executes three shuffled passes without a retained runtime cache, then three shuffled mixed-query passes through its own 4 MiB LRU. Variant order is randomized within each pair. Validation, serialization and memory sampling are outside the timer. All successful results must match exact IDs/scores from exhaustive reference execution. The oracle prepass warms OS/file/index validation caches; “uncached” means no retained SearchRuntime, not a fresh isolate or cold storage. No immediate query repeats are required in the mixed-query stream.

Each full feasible configuration has 1,920 timed queries plus 160 oracle queries. Errors are retained and excluded from latency quantiles, with counts displayed. P50/P95 weight query types equally rather than modeling traffic popularity. All Node/FS measurements are local, sequential, without artificial network latency or concurrency. Configurations run in fixed order, so cross-budget comparisons can include host/JIT/GC/thermal drift; paired comparisons within a configuration are stronger than cross-budget absolute latency comparisons.

## Index feasibility and storage

|Budget MiB|Policy|Bundle MiB|Vocabulary|Mandatory bytes|Frequency bytes|Position bytes|
|---|---|---|---|---|---|---|
|8|frequency|8.00|145185|7009789|9942037|28697886|
|8|mixed|8.00|145185|7009789|9942037|28697886|
|16|frequency|16.00|145185|7009789|9942037|28697886|
|16|mixed|16.00|145185|7009789|9942037|28697886|
|32|frequency|32.00|145185|7009789|9942037|28697886|
|32|mixed|32.00|145185|7009789|9942037|28697886|
|48|frequency|43.53|145185|7009789|9942037|28697886|
|48|mixed|43.53|145185|7009789|9942037|28697886|

On the same real-text corpus, legacy varint frequency streams total 14,734,582 bytes versus 9,942,037 bytes for v8 (32.5% smaller). Legacy positional streams total 27,809,411 versus 28,697,886 bytes in v8; optional seek tables trade space for selective access. Directory/dictionary/document data and all embedded payloads count against each budget. Total stored bytes, including metadata, are recorded per configuration.

Full JSONL ingestion build: 14.71 seconds, 679.9 decisions/second. This is a fresh full build with 100-document spill chunks. Remaining configurations are offline repacks of identical encoded streams; they are not counted as corpus build throughput.

## Execution: uncached

|MiB|Policy|Type|P50 ms baseline → optimized|P95 ms baseline → optimized|Optimized reads/query|Zero reads %|Optimized errors|
|---|---|---|---|---|---|---|---|
|8|frequency|plain|0.61 → 0.49|1.60 → 1.68|1.05|27.50|0|
|8|frequency|phrase|1.21 → 0.95|6.29 → 5.42|5.67|0.00|0|
|8|frequency|proximity|1.13 → 0.97|7.02 → 4.14|3.25|0.00|0|
|8|frequency|boolean|1.23 → 2.06|2.14 → 3.30|1.43|25.00|0|
|8|mixed|plain|0.67 → 0.55|1.76 → 1.91|1.10|25.00|0|
|8|mixed|phrase|1.47 → 1.16|6.90 → 5.90|5.40|0.00|0|
|8|mixed|proximity|1.42 → 1.08|7.65 → 4.51|3.00|5.00|0|
|8|mixed|boolean|1.41 → 2.30|2.48 → 3.54|1.45|25.00|0|
|16|frequency|plain|0.55 → 0.48|1.64 → 1.74|0.03|97.50|0|
|16|frequency|phrase|1.21 → 0.90|6.65 → 5.62|3.55|0.00|0|
|16|frequency|proximity|1.07 → 0.93|7.93 → 4.50|2.15|2.50|0|
|16|frequency|boolean|1.22 → 2.08|2.37 → 3.54|0.17|85.00|0|
|16|mixed|plain|0.60 → 0.49|1.57 → 1.65|1.05|27.50|0|
|16|mixed|phrase|1.19 → 0.90|6.31 → 5.47|4.75|0.00|0|
|16|mixed|proximity|1.24 → 0.89|7.13 → 4.20|2.75|10.00|0|
|16|mixed|boolean|1.27 → 2.04|2.14 → 3.32|1.40|25.00|0|
|32|frequency|plain|0.61 → 0.48|1.69 → 1.73|0.00|100.00|0|
|32|frequency|phrase|1.23 → 0.92|6.76 → 5.63|1.10|27.50|0|
|32|frequency|proximity|1.23 → 0.96|7.58 → 4.34|0.57|47.50|0|
|32|frequency|boolean|1.25 → 2.10|2.60 → 3.64|0.00|100.00|0|
|32|mixed|plain|0.55 → 0.44|1.58 → 1.68|0.03|97.50|0|
|32|mixed|phrase|1.20 → 0.90|6.43 → 5.58|1.70|37.50|0|
|32|mixed|proximity|1.15 → 0.97|7.43 → 4.21|0.85|42.50|0|
|32|mixed|boolean|1.23 → 2.08|2.24 → 3.34|0.30|75.00|0|
|48|frequency|plain|0.55 → 0.47|1.60 → 1.73|0.00|100.00|0|
|48|frequency|phrase|1.15 → 0.80|6.48 → 5.16|0.00|100.00|0|
|48|frequency|proximity|0.92 → 0.68|7.05 → 4.18|0.00|100.00|0|
|48|frequency|boolean|1.19 → 2.07|2.29 → 3.22|0.00|100.00|0|
|48|mixed|plain|1.09 → 0.87|3.59 → 3.43|0.00|100.00|0|
|48|mixed|phrase|2.09 → 1.35|12.00 → 11.13|0.00|100.00|0|
|48|mixed|proximity|1.80 → 1.38|14.39 → 7.90|0.00|100.00|0|
|48|mixed|boolean|2.30 → 3.79|4.95 → 7.66|0.00|100.00|0|

## Execution: mixed-cache

|MiB|Policy|Type|P50 ms baseline → optimized|P95 ms baseline → optimized|Optimized reads/query|Zero reads %|Optimized errors|
|---|---|---|---|---|---|---|---|
|8|frequency|plain|0.39 → 0.45|1.29 → 1.62|0.90|35.00|0|
|8|frequency|phrase|1.11 → 1.06|5.60 → 6.69|5.35|0.00|0|
|8|frequency|proximity|0.97 → 0.86|6.31 → 4.23|2.91|7.50|0|
|8|frequency|boolean|0.87 → 1.96|1.93 → 2.91|1.31|28.75|0|
|8|mixed|plain|0.41 → 0.47|1.19 → 1.75|0.95|32.50|0|
|8|mixed|phrase|1.18 → 1.02|6.11 → 5.57|5.10|0.00|0|
|8|mixed|proximity|1.13 → 0.97|6.25 → 4.27|2.71|13.75|0|
|8|mixed|boolean|0.87 → 1.97|1.99 → 2.97|1.32|28.75|0|
|16|frequency|plain|0.34 → 0.42|1.22 → 1.70|0.01|98.75|0|
|16|frequency|phrase|1.13 → 0.91|5.80 → 5.64|3.40|0.00|0|
|16|frequency|proximity|1.05 → 0.95|6.31 → 4.37|1.94|10.00|0|
|16|frequency|boolean|0.80 → 2.00|1.98 → 3.05|0.14|88.75|0|
|16|mixed|plain|0.45 → 0.47|1.29 → 1.65|0.89|36.25|0|
|16|mixed|phrase|1.15 → 1.10|5.59 → 5.80|4.41|0.00|0|
|16|mixed|proximity|1.05 → 0.85|6.69 → 4.23|2.49|16.25|0|
|16|mixed|boolean|0.87 → 2.05|2.10 → 3.54|1.29|28.75|0|
|32|frequency|plain|0.36 → 0.39|1.11 → 1.66|0.00|100.00|0|
|32|frequency|phrase|1.13 → 0.88|5.31 → 5.38|1.06|28.75|0|
|32|frequency|proximity|0.95 → 0.74|5.95 → 4.13|0.54|51.25|0|
|32|frequency|boolean|0.81 → 1.92|1.91 → 2.69|0.00|100.00|0|
|32|mixed|plain|0.34 → 0.36|1.13 → 1.62|0.01|98.75|0|
|32|mixed|phrase|1.08 → 0.86|5.03 → 5.16|1.51|37.50|0|
|32|mixed|proximity|0.89 → 0.74|5.79 → 4.18|0.78|48.75|0|
|32|mixed|boolean|0.80 → 1.86|1.94 → 2.64|0.24|80.00|0|
|48|frequency|plain|1.85 → 2.01|10.28 → 11.92|0.00|100.00|0|
|48|frequency|phrase|4.17 → 3.32|21.58 → 19.47|0.00|100.00|0|
|48|frequency|proximity|3.85 → 3.10|25.75 → 14.46|0.00|100.00|0|
|48|frequency|boolean|3.34 → 7.25|11.66 → 23.45|0.00|100.00|0|
|48|mixed|plain|1.57 → 1.58|5.65 → 7.14|0.00|100.00|0|
|48|mixed|phrase|4.35 → 3.05|20.87 → 14.87|0.00|100.00|0|
|48|mixed|proximity|3.28 → 2.74|20.66 → 11.00|0.00|100.00|0|
|48|mixed|boolean|3.66 → 8.47|10.27 → 13.92|0.00|100.00|0|

## Local Worker validation

|MiB (mixed)|HTTP responses|P50 ms|P95 ms|Process startup wall ms|
|---|---|---|---|---|
|8|48|12.31|45.00|323.53|
|16|48|10.24|22.26|167.67|
|32|48|10.58|27.61|188.43|
|48|48|15.28|34.82|645.38|

The actual Wrangler-built Worker runs in local workerd/Miniflare with its R2 binding. Sixteen evaluation queries (four per type), three passes per feasible budget. Every response must succeed, omit total by default, and match exhaustive Node IDs/scores (1e-12 cross-runtime score tolerance). HTTP timing includes local dispatch and response parsing, excludes validation. Startup includes local process creation/IPC. This is not deployed Cloudflare/R2 latency or isolate startup CPU.

## Limits
The source sample is 10,000 decisions; do not extrapolate its dictionary/length distribution or latency linearly to millions. Some source decisions have multiple opinions and OCR artifacts. Concatenating opinions permits token-distance matching across opinion boundaries. Workload selection is artificial, equal-weight and partially corpus-derived; it cannot establish real traffic cache hit rates or relevance quality. The small local workerd workload is functional runtime validation. Host RSS includes oracle/fixture buffers and allocator retention, not isolate memory. No concurrent load, deployed R2, geographic latency or production eviction is measured. No ranking-quality judgments are supplied.

## Reproduction
```sh
uv venv work/flp-venv
uv pip install --python work/flp-venv/bin/python -r bench/flp-requirements.txt
work/flp-venv/bin/python bench/sample-flp.py
node --import tsx bench/flp-prepare.ts
node --import tsx bench/flp-build.ts
node --import tsx bench/flp-run.ts
node --import tsx bench/flp-worker.ts
python3 bench/flp-report.py
```
Use a fresh `bench/generated/flp/source` output for a new build: production generations are immutable and the builder rejects overwriting an existing generation. The sampler reads footers and one row group per shard, with source read traffic substantially exceeding the final sample size. The source dataset revision and dependency versions are pinned. Full texts/indexes stay in ignored generated files; source selection, corpus hash, workloads and raw benchmark results are committed.
