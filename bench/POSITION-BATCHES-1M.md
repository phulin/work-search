# Physical phrase planning and positional batching on 1M documents

Local simulated-I/O comparison against `55fff24b543fe0bf3ec37daedf1e22de0a741b11`,
using the same retained complete-context 1M index. No format, context, tokenization,
ranking formula or excerpt changes. No Cloudflare activity, deployment or upload.

## Cold results: 200 queries, exact totals off

Three observations per engine/query, **1,200 correct complete responses**. The
table uses percentiles of query medians; these are workload statistics.

| Percentile |    Control |        New | Change |
| ---------- | ---------: | ---------: | -----: |
| P50        |   392.1 ms |   381.1 ms |  −2.8% |
| P95        | 1,325.8 ms | 1,024.3 ms | −22.7% |
| P99        | 1,991.5 ms | 1,821.0 ms |  −8.6% |

Pooled empirical percentiles across 600 measured requests per engine are
**392/1,344/1,997 → 383/1,022/1,824 ms**. There are 124 faster query medians and
76 slower ones. Requiring both 10% and 10 ms gives **36 wins and zero material
cold regressions**; that threshold is descriptive, not a significance test.

| Workload class             | Queries | Control P50/P95/P99, ms | New P50/P95/P99, ms |
| -------------------------- | ------: | ----------------------: | ------------------: |
| Rewritten research queries |     180 |     354 / 1,356 / 2,147 | 340 / 1,035 / 1,970 |
| Unfamiliar queries         |      20 |       544 / 979 / 1,036 |     538 / 692 / 834 |

| Query                                              | Cold median, ms | Ordinary-word position waves | Total origin MiB |
| -------------------------------------------------- | --------------: | ---------------------------: | ---------------: |
| Fraud on the court / nonparty / appeal             |   2,286 → 1,700 |                       49 → 0 |      64.7 → 45.6 |
| Limitations / concealment / motion to dismiss      |     2,147 → 865 |                       41 → 0 |      70.7 → 21.2 |
| Rule 15 / undue prejudice / leave to amend         |     1,585 → 580 |                       37 → 0 |      39.2 → 13.5 |
| Stay discovery / motion to dismiss                 |     1,603 → 727 |                       39 → 0 |      40.8 → 16.4 |
| Rule 26(f) / defer or stay / motion to dismiss     |     1,286 → 701 |                       28 → 0 |      31.8 → 15.8 |
| Rule 6(b) / excusable neglect / late opposition    |     1,421 → 730 |                       35 → 9 |      22.8 → 22.8 |
| Public access / summary judgment hearing / closure |     1,326 → 597 |                       35 → 8 |      21.5 → 21.5 |
| Rule 62.1 / dissolve / preliminary injunction      |     1,498 → 780 |                      38 → 10 |      22.1 → 22.1 |

Zero ordinary-word waves means complete pair context establishes the phrases;
its own positional reads and decoding still occur and are included in total
bytes and latency. Limitations scans 455,606 pair occurrences and reduces score
postings decoded from 545,394 to 215,154. Rule 6(b), public access and Rule 62.1
instead retain exactly the same ordinary position integers, score postings and
physical transfer bytes: batching/coalescing removes waits and GETs. Their
origin request counts fall **90 → 68**, **81 → 58** and **88 → 58** respectively.

The largest observed positional fetch footprint is **4,194,304 bytes**; peak
queued numeric evidence is **32,299 bytes**, and the largest combined positional
buffer estimate is **4,208,190 bytes**. These cover the new scheduler only,
excluding the existing caches, scoring workspace, pair-stream buffers, bundle
and presentation. They are not native peak/retained-memory measurements.

The separate 29-case cold regression set has P50/P95/P99 **560/1,676/1,976 →
548/1,131/1,932 ms**. Existing phrase paths remain intact: `"in the absence of"`
takes **664 → 653 ms**, `"burden of proving"` **560 → 540 ms**, and the mixed
negative jurisdiction/summary-judgment/res-ipsa query **664 → 662 ms**. Those
small differences are not evidence of a substantial gain for these cases.

## Correctness and checks

The main 200-query comparison, focused cold set and independent 160-query oracle
produce **1,534 correct responses**, excluding untimed startup/JIT preparation.
Ordered document IDs, metadata, snippets and applicable exact totals agree;
oracle scores use relative tolerance 1e-11. All **314 tests across 85 files** pass,
including local workerd integration, independent exhaustive matching/ranking,
negative/proximity branches, fields, ties, exact totals and pagination.

New tests exercise cross-window coalescing without unused-page gaps, buffer
retention through cache eviction, splitting oversized candidate groups without
dropping documents, immutable candidate-only numeric snapshots, and physical
phrase costing that changes appropriately with actual application residency.
Typechecking, formatting of changed files and `git diff --check` pass.

## Remaining costs and regressions

Fraud-on-the-court trades I/O for a complete scan of **3,398,661 pair occurrences**.
Local process CPU rises **1,028 → 1,343 ms** while cold latency falls. Its context
scan remains expensive. Process CPU under simulated delays is not a native
Worker CPU measurement or an exclusive share of wall time.

The five document-verification queries are largely unaffected by this change.
Intervention remains **1,992 → 2,006 ms** and admission **1,980 → 1,970 ms**, with
462 and 452 origin requests respectively. Reducing their many small verification
GETs is the next cold priority. Excerpt retrieval remains lower priority.

Smaller observed cold slowdowns remain: arson/proximate-cause/fire-suppression
**524 → 568 ms (+8.4%)**, and Rule 408/another-purpose/retaliation
**934 → 964 ms (+3.3%)**. These are below the chosen materiality threshold;
they are not being declared noise. Full per-query observed ranges and CPU/work
counters are in the evidence directory.

## Execution changes

The old filtered-phrase comparison scaled total term bytes by candidate count
divided by DF. It ignored scattered physical pages and dependent positional
fetches. The new comparison inspects candidate-overlapping posting-block
addresses in bounded metadata windows, counts physical pages and application
residency, and estimates coalescible GETs and fetch stages. It compares that cost
with a complete pair-context scan. Occurrence-decoding costs remain estimates;
the model chooses a complete execution path, never discards candidates.

The ordinary positional continuation now queues compact evidence from up to
eight scored document windows. It copies candidate IDs, exact scores, frequencies
and posting-row handles, rather than retaining full scoring workspaces. Across
those candidates it deduplicates positional block references, groups overlapping
and adjacent pages into GET ranges, and verifies in document order after each
bounded fetch batch. It fills no gaps of whole unused pages. Pages stay referenced
until consumed even if the LRU evicts them, and closures drop their views after
each consumed batch.

Only verified matches raise the competitive threshold. The initial nonempty
window is verified before scoring ahead. A weaker threshold during subsequent
lookahead can fetch or decode extra scores; exact totals still visit every match.
Complete-context windows needing no ordinary positions are verified immediately.
The AST evaluator, phrase spans and snippet algorithms are unchanged.

Numeric candidate storage and positional page-backed data each target 4 MiB.
One indivisible window/document can exceed a soft byte target under existing
resource limits. These are active-work estimates, not measurements of native
heap peak or retained memory. There is no candidate-count cutoff and no bitmap
index.

## Measurement contract

The 200-query performance contract has every exact total explicitly off and
includes the 180 rewritten research queries plus 20 unfamiliar queries. Complete
response timing includes metadata, query-relevant snippets and JSON serialization.
Cold comparisons have three observations per engine/query. Engines are randomized
and interleaved with independent per-query/engine/repetition application and
shared caches. Source digests are checked before and after each run.

The model is 20 ms origin latency plus 100 MiB/s, 2 ms shared-cache latency plus
1,000 MiB/s, six request slots, 256 MiB simulated shared cache, 12 MiB application
page cache, 4 MiB decoded cache and a 900-operation shared-cache budget. These are
simulations, not native Worker or client HTTP measurements. The filesystem and
Node process/JIT are reused; empty caches do not model a new isolate or opaque
R2 backend caches. No response caching is used.

The 29-case focused contract separately retains seven exact-total cases; those
are correctness/regression checks and are not pooled into the totals-off 200.
The separate independent oracle contains 160 queries, clears caches before
each case and disables artificial delays for correctness checking only. Per-query sample sizes
remain small: percentiles of query medians describe this workload, not production
traffic or reliable production P99 estimates.

## Reproduce

With `work/complete-context-v2-1m` retained locally:

```sh
yarn node --import tsx bench/columnar/run-position-batches.ts
yarn test
yarn run check
yarn node --import tsx bench/columnar/report-position-batches.ts
```

The runner reconstructs the frozen control from Git and reads existing local
contracts and immutable index objects. It does not prepare/download missing
objects. Run timed comparisons without concurrent tests, profiling or construction.
Per-query CSV/JSON, raw observations and manifests are retained in
[the evidence directory](results/columnar/position-batches-1m).
