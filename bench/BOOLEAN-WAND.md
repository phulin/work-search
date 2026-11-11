# Boolean recovery, then pivot WAND

## Implementation and scope
The Boolean recovery was implemented and benchmarked first, then WAND was added and benchmarked separately. Index bytes, embedded budgets (8/16/32/48 MiB), BM25 arithmetic, tie ordering and the 4 MiB cache cap remain unchanged. Existing v6–v8 indexes with persisted impacts support both block executors; v5, positional/negative queries, metadata requests and exact-total requests keep the materialized executor. No index rebuild or re-upload is needed for this execution-only change.

Small mixed Boolean trees now use sorted materialized set operations; large trees can use compiled AND/OR iterators ordered by estimated document frequency. An AND drives its selective branch instead of enumerating the union of every term. Duplicate AST leaves have independent cursors sharing verified data, preserving `(A AND B) OR A`. Block-window bounds are reused until their validity interval ends. Per-document array allocation and recursive AST testing are removed from this path. Complete cached posting lists are shared with the materialized executor; cursors use cached arrays directly.

WAND is a literal pivot-based implementation: sort active document cursors, select a pivot using global field-aware score upper bounds, seek earlier cursors when their prefix cannot beat the heap, then apply block-local interval bounds before scoring. Positive Boolean predicates can filter WAND candidates; automatic routing currently selects WAND only for pure disjunctions. Exact-order partial bounds are memoized by term subset so floating-point additions follow the scorer’s original term/body/title order. Equal scores retain input-order ties. At 16 terms, the memo table is at most 512 KiB of query working memory, explicitly included in the existing guard; it adds no serialized index bytes.

Automatic routing is intentionally conservative: WAND needs at least two OR terms, summed df ≥ 4,096, max/min df ≥ 2, top-K ≤ 20, a body-enabled field, and fewer than half the posting rows already available as complete cached lists. Small/cached mixed trees use materialized execution; forced Boolean/WAND modes are internal benchmark/library options, never HTTP parameters. The df/caching heuristic was informed by the supplemental OR experiment, then frozen before evaluating the separate 40-query OR set. It is a heuristic, not a learned optimal planner.

## Measurement method
All measurements use the unchanged 10,000-decision COLD Cases sample and original embedding-training strings from [FREE-LAW-PROJECT.md](FREE-LAW-PROJECT.md). The 160 original held-out queries remain. The WAND experiment adds 21 distinct supplemental OR strings (used to inform routing) and 40 separately seeded OR strings using 2/4/8/16 legal terms. The 40-string set is separate from tuning strings; terms and corpus overlap. This is an artificial stress test, not attorney traffic or relevance evaluation.

Five variants share identical encoded bytes: `before` freezes the previous block executor; `recovered` is the repaired executor with materialized execution on supplemental/held-out OR queries; `tree` forces composable Boolean block execution; `wand` forces WAND on eligible positive trees; `auto` uses final routing. Each query/variant runs three shuffled uncached passes and three shuffled mixed-cache passes. Variant order is randomized within query pairs. Cache contexts are separate (4 MiB each); a benchmark process can retain five contexts, unlike a single deployed Worker. Correctness checks, JSON hashing and memory sampling are outside timing. Exhaustive reference results are prepared first, so OS/filesystem/JIT/document validation may be warm. Uncached means no retained SearchRuntime, not a cold isolate or cold R2. Mixed-cache tables use passes 1–2; pass 0 is retained in raw results.

## First stage: Boolean recovery before WAND

|MiB|Cache mode|Executor|Boolean P50 ms|Boolean P95 ms|
|---|---|---|---|---|
|8|uncached|before|2.29|3.65|
|8|uncached|recovered|1.20|2.33|
|8|uncached|tree|1.33|2.57|
|8|mixed-cache|before|5.37|9.66|
|8|mixed-cache|recovered|2.63|6.65|
|8|mixed-cache|tree|3.38|10.27|
|48|uncached|before|4.67|10.33|
|48|uncached|recovered|2.27|5.52|
|48|uncached|tree|2.59|6.68|
|48|mixed-cache|before|3.66|5.27|
|48|mixed-cache|recovered|1.62|3.47|
|48|mixed-cache|tree|2.10|5.26|

These first-stage samples predate WAND and remain separate from final measurements. They show recovery without relying on WAND. Forced tree execution is not the best choice for every small list; automatic routing preserves the materialized fast path.

## Final matrix: original mixed Boolean workload

|MiB|Embedding|Warm P50 ms before → auto|Warm P95 ms before → auto|Auto reads/query|Auto bytes/query|Errors|
|---|---|---|---|---|---|---|
|8|frequency|1.98 → 0.98|3.10 → 2.14|1.25|4883|0|
|8|mixed|2.00 → 0.94|3.14 → 2.27|1.27|5248|0|
|16|frequency|1.96 → 0.86|3.09 → 2.14|0.14|1577|0|
|16|mixed|1.80 → 0.92|2.84 → 2.11|1.23|4880|0|
|32|frequency|1.78 → 0.83|2.57 → 2.08|0.00|0|0|
|32|mixed|1.87 → 0.85|2.84 → 2.16|0.24|2363|0|
|48|frequency|1.76 → 0.81|2.64 → 2.00|0.00|0|0|
|48|mixed|1.78 → 0.81|2.59 → 2.03|0.00|0|0|

## WAND: separate 40-query OR set

|MiB|Embedding|Cache mode|P50 ms recovery → auto|P95 ms recovery → auto|Recovery scored docs|Forced WAND scored docs|Auto scored docs|
|---|---|---|---|---|---|---|---|
|8|frequency|uncached|2.06 → 1.34|7.92 → 6.93|5362|1058|1370|
|8|frequency|mixed-cache|1.70 → 1.91|7.31 → 8.10|5362|1058|2756|
|8|mixed|uncached|2.33 → 1.81|8.06 → 9.37|5362|1058|1370|
|8|mixed|mixed-cache|1.67 → 1.86|7.66 → 8.07|5362|1058|2756|
|16|frequency|uncached|2.18 → 1.47|7.87 → 6.63|5362|1058|1370|
|16|frequency|mixed-cache|1.52 → 1.73|6.60 → 7.51|5362|1058|2756|
|16|mixed|uncached|2.20 → 1.35|7.88 → 6.55|5362|1058|1370|
|16|mixed|mixed-cache|1.75 → 1.69|6.77 → 7.39|5362|1058|3161|
|32|frequency|uncached|2.06 → 1.51|7.73 → 7.56|5362|1058|1370|
|32|frequency|mixed-cache|1.53 → 1.64|6.11 → 6.69|5362|1058|3494|
|32|mixed|uncached|2.04 → 1.65|7.74 → 6.32|5362|1058|1370|
|32|mixed|mixed-cache|1.50 → 1.71|6.56 → 6.81|5362|1058|3307|
|48|frequency|uncached|2.03 → 1.26|7.70 → 6.22|5362|1058|1370|
|48|frequency|mixed-cache|1.49 → 1.50|5.77 → 6.56|5362|1058|3736|
|48|mixed|uncached|1.99 → 1.18|7.69 → 6.31|5362|1058|1370|
|48|mixed|mixed-cache|1.50 → 1.49|6.10 → 6.08|5362|1058|3736|

WAND reduces scoring work substantially, but it is not uniformly faster on hot caches or very common, similarly frequent terms. Sorting/pivot/bound costs remain, and complete cached arrays can make materialized execution cheaper. The report retains warm-tail regressions and the forced-WAND control; reduced documents scored must not be read as a guaranteed latency reduction. Global maxima are derived from existing directories; no frequency scan is needed to construct them for blocked lists. Small lists compute maxima from their already decoded rows.

## Local Worker validation

|MiB, mixed embedding|Measured HTTP responses|HTTP P50 ms|HTTP P95 ms|Process startup wall ms|
|---|---|---|---|---|
|8|39|1.50|7.95|162.76|
|16|39|1.41|7.44|66.00|
|32|39|1.45|7.42|95.30|
|48|39|1.51|7.27|157.79|

The actual Wrangler-built Worker runs in local workerd/Miniflare using its R2 binding. Thirteen Boolean/OR shapes × three passes × four budgets = 156 timed HTTP responses. An additional 104 untimed HTTP requests compare default/pruned results exactly with exhaustive results within workerd, with assertions that real HTTP routing exercises WAND and Boolean blocks, plus Node ID/score checks (1e-12 cross-runtime tolerance). Startup includes process launch/IPC; this is not deployed Cloudflare latency, startup CPU, or an account-limit test.

## Correctness and diagnostics
Tests compare exact top-K IDs/scores for Boolean grouping, repeated leaves, fields, boosts including fractional near-ties, limits 1–100, full-local and full-remote layouts, randomized trees and 16-term WAND subsets. Additional tests ensure pivots skip low-impact documents, selective unions drive AND traversal, and preloaded complete postings support forced execution without storage reads. Total=true remains exact and bypasses top-K-only pruning.

New diagnostics identify the executor, ranked/visited documents, logical nonsequential cursor seeks, asynchronous cursor loads, blocks decoded, block-cache hits, complete-posting cache hits, WAND pivots and pivot skips. The pre-WAND/initial trial files use the earlier cursorSeeks counter for asynchronous loads; final files distinguish both. Snapshot `before` lacks the new counters, so its zero-filled diagnostic summary must not be interpreted as zero traversal.

## Limits and reproduction
Remote frequency misses still fetch whole streams to avoid request amplification; WAND primarily saves decoding/scoring CPU and working arrays, not cold R2 bytes. Cache hits can avoid those reads. Mixed trees with OR under AND are routed separately from pure OR WAND; the forced mode is not a recommendation for all Boolean queries. Concurrent isolate working-set peaks, deployed R2, real query logs and larger legal corpora remain unmeasured. Configurations run in fixed order and share a host, so comparisons within randomized pairs are stronger than cross-budget absolute comparisons. Multiple cache contexts and host GC can affect tails; no confidence interval is claimed.

```sh
npm run check
npm test
# Requires the unchanged FLP generated corpus/index fixtures.
node --import tsx bench/boolean-task.ts 8 mixed boolean
node --import tsx bench/boolean-task.ts 48 mixed boolean
node --import tsx bench/boolean-run.ts
node --import tsx bench/boolean-worker.ts
python3 bench/boolean-report.py
```
Raw per-configuration samples are referenced by results/boolean-final.json; the compact index avoids duplicating all samples in a second large file. Aggregate metrics are in results/boolean-summary.json. Initial WAND trials are retained separately. Full index generations and immutable R2 objects are unchanged.
