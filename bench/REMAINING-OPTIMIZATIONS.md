# Four remaining performance optimizations

Implemented together: joint frequency/position embedding (`--strategy mixed`); broader Boolean candidate plans, galloping intersections, cost-based range grouping and deferred positions; exact top-K block-max score pruning (`total=false`); and a bounded warm-isolate LRU cache (default 4 MiB, configurable 0–8 MiB). Embedded budgets remain 8/16/32/48 MiB. Existing v5 indexes remain compatible; only adopting a new embedding policy requires a new generation.

## Method

12 configurations: 10k/100k/1m documents × four budgets. Each embedding policy is repacked from identical v5 encoded posting/document bytes and trained on the same 12 plain + 7 connector queries. Eight additional queries are held out and reported separately. Repacking time/RSS is recorded as repacking, not corpus-index construction throughput. Per-configuration query measurement runs in a separate Node child process and alternates policy/planner order over three passes. Every variant must return identical IDs and exact scores; exact totals must match except when deliberately omitted for pruning. Metadata equivalence is also checked.

Cache/pruning experiments use one cache-cold run and three cache-warm runs per query. “Cold” means an empty runtime cache/bounds context; encoded data, OS caches, and the index/document validation state are already warm. Cache trials repeat a query within one context, so their gains assume locality. Bounds and postings share the same 4 MiB LRU. Standard 24-configuration and real local workerd benchmarks are rerun separately. All latency is local, not deployed Cloudflare/R2 latency. Query-process RSS here includes three resident index fixtures and must not be interpreted as Worker isolate memory.

## 1. Joint embedding

Complete-query packages purchase all required frequency and positional streams, weighted by supplied query frequency, then fill remaining space by avoided stream reads per byte. Both policies see the same training workload; this avoids attributing a workload change to the algorithm. Training local-hit rates are optimistic. Packages are a deterministic heuristic, not a globally optimal knapsack solver.

|Docs|MiB|Plain zero reads % freq → joint|Connector zero reads % freq → joint|Connector reads/query freq → joint|Held-out zero reads % freq → joint|Held-out reads/query freq → joint|
|--:|--:|--:|--:|--:|--:|--:|
|10000|8|100.0 → 100.0|100.0 → 100.0|0.00 → 0.00|100.0 → 100.0|0.00 → 0.00|
|10000|16|100.0 → 100.0|100.0 → 100.0|0.00 → 0.00|100.0 → 100.0|0.00 → 0.00|
|10000|32|100.0 → 100.0|100.0 → 100.0|0.00 → 0.00|100.0 → 100.0|0.00 → 0.00|
|10000|48|100.0 → 100.0|100.0 → 100.0|0.00 → 0.00|100.0 → 100.0|0.00 → 0.00|
|100000|8|100.0 → 100.0|14.3 → 100.0|1.86 → 0.00|25.0 → 62.5|1.62 → 0.75|
|100000|16|100.0 → 100.0|28.6 → 100.0|1.43 → 0.00|50.0 → 62.5|0.88 → 0.75|
|100000|32|100.0 → 100.0|100.0 → 100.0|0.00 → 0.00|100.0 → 100.0|0.00 → 0.00|
|100000|48|100.0 → 100.0|100.0 → 100.0|0.00 → 0.00|100.0 → 100.0|0.00 → 0.00|
|1000000|8|58.3 → 58.3|28.6 → 28.6|3.14 → 2.57|0.0 → 0.0|2.75 → 2.62|
|1000000|16|91.7 → 91.7|28.6 → 57.1|1.86 → 1.14|0.0 → 25.0|2.00 → 1.88|
|1000000|32|100.0 → 100.0|28.6 → 100.0|1.71 → 0.00|25.0 → 62.5|1.50 → 0.75|
|1000000|48|100.0 → 100.0|28.6 → 100.0|1.71 → 0.00|25.0 → 62.5|1.38 → 0.75|

## 2. Candidate and range planning

Necessary coarse predicates can include a union of rare terms, such as `(rare1 OR rare2) AND common`, even with no rare obligatory individual term. Negative-only predicates cannot anchor. At an eightfold selectivity disparity, frequencies are combined first and only intersecting positional blocks are attached afterward, reusing decoded frequency arrays and directories. Range partitions minimize an explicit bytes + 64 KiB/request-equivalent cost under four windows, instead of fixed geometric windows; galloping intersections avoid scanning highly skewed arrays. The 64 KiB estimate is a local policy default, not a measured production R2 cost.

|Docs|MiB|P50 ms previous → adaptive|P95 ms previous → adaptive|Reads/query previous → adaptive|Bytes/query previous → adaptive|
|--:|--:|--:|--:|--:|--:|
|10000|8|0.48 → 0.14|1.26 → 0.70|0.00 → 0.00|0 → 0|
|10000|16|0.58 → 0.15|1.33 → 0.96|0.00 → 0.00|0 → 0|
|10000|32|0.49 → 0.15|1.30 → 0.56|0.00 → 0.00|0 → 0|
|10000|48|0.44 → 0.19|1.22 → 0.79|0.00 → 0.00|0 → 0|
|100000|8|2.81 → 1.22|6.82 → 5.25|1.00 → 1.00|60598 → 60468|
|100000|16|2.65 → 1.11|6.89 → 3.42|0.67 → 0.67|59924 → 59793|
|100000|32|2.43 → 0.93|5.30 → 2.75|0.00 → 0.00|0 → 0|
|100000|48|2.47 → 0.93|5.26 → 2.76|0.00 → 0.00|0 → 0|
|1000000|8|16.52 → 6.86|39.48 → 40.97|2.50 → 2.83|3119393 → 3118492|
|1000000|16|16.10 → 9.60|39.75 → 33.33|1.00 → 1.00|607544 → 607413|
|1000000|32|14.72 → 7.12|46.40 → 42.99|1.00 → 1.00|607544 → 607413|
|1000000|48|14.66 → 6.57|35.99 → 28.75|1.00 → 1.00|607544 → 607413|

## 3. Block-max score pruning

This is block-max score pruning after frequency decoding, not a pivot-WAND iterator or an on-disk Block-Max WAND format. The first query builds title/body score maxima for 1,024-document windows from validated postings and document lengths. Subsequent queries reuse bounded cached maxima when available. Bound summation follows the scorer’s exact floating-point operation order, including title boosting. A window cannot beat the heap when its upper bound is lower, or equal with later internal document IDs; those candidates skip scoring and, for connector queries, positional matching. Top-K remains exact. The response omits total whenever `total=false`, including fallback/empty queries. Default total=true preserves exact counts and exhaustive scoring.

Bounds construction costs CPU on cache-cold calls; full frequency I/O/decoding and coarse candidate construction still happen. This implementation targets warm scoring CPU, not R2 bytes. The workload below has four broad plain queries per configuration.

|Docs|MiB|Exact-total P95 ms|Pruned cold P95 ms|Pruned warm P95 ms|Warm candidates pruned %|Warm mean scored docs|
|--:|--:|--:|--:|--:|--:|--:|
|10000|8|2.48|1.23|0.59|59.6|3814|
|10000|16|4.17|1.54|1.75|59.6|3814|
|10000|32|2.50|1.25|0.66|59.6|3814|
|10000|48|2.26|1.18|0.53|59.6|3814|
|100000|8|8.90|7.20|3.37|71.9|26522|
|100000|16|9.12|6.56|3.13|71.9|26522|
|100000|32|8.93|6.55|3.05|71.9|26522|
|100000|48|22.16|6.67|15.24|71.9|26522|
|1000000|8|70.04|50.37|37.65|80.0|189399|
|1000000|16|67.00|50.45|34.14|80.0|189399|
|1000000|32|61.50|47.10|35.50|80.0|189399|
|1000000|48|71.38|49.09|36.37|80.0|189399|

## 4. Warm-isolate cache

The LRU is keyed by immutable generation, term, stream kind and CRCs. Only complete verified posting lists enter the cache; partial positional attachments never masquerade as full lists. Bounds share the same capacity. Oversized entries are rejected, memory headroom can lower the effective ceiling, and entries are charged for typed buffers, directories and key/object overhead. Cached arrays are reused read-only and each request owns its cursors and new positional attachments. This is a bounded cache, not a global concurrency/memory guarantee for overlapping requests. Cold isolates and lists larger than capacity still perform reads and decoding.

|Docs|MiB|Uncached P95 ms|Cache-cold P95 ms|Warm P95 ms|Uncached → warm reads/query|Warm zero reads %|Max charged cache MiB|
|--:|--:|--:|--:|--:|--:|--:|--:|
|10000|8|0.25|0.18|0.15|0.00 → 0.00|100.0|0.03|
|10000|16|0.46|0.24|0.17|0.00 → 0.00|100.0|0.03|
|10000|32|0.20|0.19|0.24|0.00 → 0.00|100.0|0.03|
|10000|48|0.20|0.21|0.17|0.00 → 0.00|100.0|0.03|
|100000|8|1.03|0.88|0.34|0.50 → 0.00|100.0|0.27|
|100000|16|1.70|1.32|0.46|0.50 → 0.00|100.0|0.27|
|100000|32|0.80|0.67|0.42|0.00 → 0.00|100.0|0.27|
|100000|48|0.69|0.65|0.32|0.00 → 0.00|100.0|0.27|
|1000000|8|11.43|6.69|3.02|0.50 → 0.00|100.0|2.70|
|1000000|16|8.08|6.11|2.66|0.50 → 0.00|100.0|2.70|
|1000000|32|8.36|6.34|2.63|0.50 → 0.00|100.0|2.70|
|1000000|48|7.71|5.99|2.57|0.50 → 0.00|100.0|2.70|

## Actual local Worker validation

Eleven uncached/exact configurations (264 measured HTTP responses) and five cached/pruned configurations (120 measured responses) run in Miniflare/workerd. For each pruned query, results/scores are compared exactly with exhaustive execution in the same Worker after measured passes. A separate Node oracle checks IDs/counts and score tolerance 1e-12 to allow cross-runtime Math differences. No measured request failed. Cache cold/warm pass labels are retained; the table below includes all three passes.

|Configuration (cache 4 MiB, total=false)|HTTP P50 ms|HTTP P95 ms|Warm reads/query|
|--|--:|--:|--:|
|100000-8-workload|2.73|15.80|0.62|
|1000000-8-workload|14.32|69.77|1.75|
|1000000-16-workload|13.08|63.76|0.75|
|1000000-32-workload|13.63|64.51|0.62|
|1000000-48-workload|12.89|68.70|0.75|

## Configuration and reproduction

Build a joint generation: `npm run build-index -- --input corpus.jsonl --out indexes/mixed-v5 --budget-mib 8 --strategy mixed --workload queries.txt`. Use a representative mix including phrases/proximity, with a separate held-out set for evaluation. CLI top-K without counts: `npm run search-local -- --out indexes/mixed-v5 --query "example" --no-total`. HTTP: `/search?q=example&total=false`. Set Wrangler `CACHE_MIB` to 0–8 (default 4); 0 disables retention. All default API queries still report exact totals.

Reproduce: `npm run check`, `npm test`, `npm run bench -- --reuse-indexes`, `node --import tsx bench/remaining.ts`, `node --import tsx bench/runtime.ts`, `node --import tsx bench/remaining-worker.ts`, `python3 bench/remaining-report.py`. For a fresh checkout, first run `npm run bench` to create the standard v5 corpus/index/construction records; repacking reuses their encoded streams. Raw ablations and repacking records are in results/remaining.json, standard matrix results in results/results.json, local cached/pruned workerd results in results/remaining-workerd.json, and uncached/exact workerd results in results/workerd.json. No Cloudflare deployment was performed.

Next work: persist tight score bounds with index blocks if cold-query pruning matters, implement pivot-based WAND/score-ordered block iterators to also avoid decoding, calibrate range costs on deployed R2, and evaluate cache/embedding on larger real query traces.
