# Local 1M profile of 180 legal research queries

This profiles the latest 180-query export from the “Create Lexis-style research
queries” chat: `data/courtlistener-brief-research/queries.jsonl`, 109 Boolean and
71 proximity queries inferred from federal briefs. It is not the older Stanford
bar export or actual attorney search traffic. The source dataset and engine are
unchanged. No deployments, uploads or live Cloudflare calls occurred.

Nine queries use unsupported Lexis root expansion. With user authorization, the
workload replaces each root with a recorded, explicit finite OR expression.
For example, `seal!` becomes `(seal OR sealed OR sealing)`. Both original and
executed queries, and all root alternatives, are retained in the results. These
rewrites preserve the intended research topics; they do not implement arbitrary
prefix expansion. Existing NFKC/lowercase/Porter2 analysis applies normally.

Existing proximity semantics also apply: `W/S` is a 25-token window and `W/P` a
75-token window. These are not actual Lexis sentence/paragraph boundaries. There
are no new query semantics, index formats, context encodings or excerpt changes.

## Measurement

The engine revision is `d51e79b`, on the existing local 1M generation with
N=100/M=1000. Full search responses include metadata, query-relevant excerpts and
JSON serialization: limit 20, all fields, title boost 2, implicit AND, exactTotal
false, and no response cache. Generation, input and source identities are stored
with every run.

Each of three randomized query orders runs both cache conditions, randomly
ordered within the query:

- Application reuse immediately after this query's priming/execution.
- Empty application caches over the same primed simulated shared namespace.

Application pages are 12 MiB, decoded data 4 MiB, simulated shared pages 1 GiB.
Each query/repetition starts with cleared application/shared caches and one
untimed, no-delay search to prime shared data; application caches are cleared
in-process before the empty-application measurement. The bounded caches can
still evict data during a query. This measures repeated-query reuse, not
inter-query cache capacity, a new isolate or startup. Filesystem caches are
uncontrolled.

The model adds 20 ms plus 100 MiB/s to origin reads, and 2 ms plus 1,000 MiB/s to
shared operations, inside the real Reader scheduling. A third observation disables
modeled delays and measures local process CPU per query. It also records process
CPU through completion of deferred cache writes. There is no concurrent benchmark
process or inspector during these measurements.

A separate process profiles all 180 queries: two warmups, four complete responses
under the V8 CPU sampler (500 microseconds), then two under the heap sampler
(32 KiB, including collected objects). Sample time includes idle/filesystem waits;
process CPU is the separate no-delay measurement. Heap samples estimate
cumulative allocation, not retained or peak Worker memory. This is Node
attribution, not native Cloudflare performance evidence.

Exact complete-response hashes, excluding diagnostics, must agree across all
repetitions, cache conditions and inspector passes. These new queries have no
independent exhaustive 1M oracle or relevance judgments; hash agreement establishes
reproducibility, not independent retrieval correctness. The engine's existing
correctness suite remains unchanged.

## Reproduction

```sh
yarn node --import tsx bench/columnar/research-profile.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m data/courtlistener-brief-research/queries.jsonl work/research-profile-180
cp data/courtlistener-brief-research/queries.jsonl work/research-profile-180/source-queries.jsonl
CWS_RESEARCH_PHASE=profile yarn node --import tsx bench/columnar/research-profile.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/research-profile-180/source-queries.jsonl work/research-profile-180
yarn node --import tsx bench/columnar/research-profile-report.ts work/research-profile-180 bench/results/columnar/research-180-1m
```

The second command uses a local copy of the original JSONL, with the same source
hash. `queries.json` in the archived results preserves the minimal original and
rewritten workload without copying the source briefs. To reconstruct a JSONL
input from it, use each row's `original` as `query`, retaining `brief_id`,
`query_style` and `research_purpose`.

## Results

All 180 queries completed, including the nine rewrites. There were 1,080 simulated
latency measurements, 540 no-delay CPU measurements, 720 CPU-profiled responses
and 360 allocation-profiled responses. All complete-response hashes agreed, with
zero errors and zero downloads.

The following quantiles are **across per-query medians**, giving each query equal
weight. Each median has only three observations. They are workload summaries,
not production traffic percentiles, individual-query tail estimates or confidence
intervals. P99 in particular reflects one or two slow query scenarios.

| Workload         | Queries | CPU P50 / P95 / P99, ms | Reused application P50 / P95 / P99, ms | Empty application P50 / P95 / P99, ms |
| ---------------- | ------: | ----------------------: | -------------------------------------: | ------------------------------------: |
| All              |     180 |          69 / 180 / 853 |                      188 / 562 / 3,808 |                     199 / 854 / 4,930 |
| Boolean          |     109 |          77 / 195 / 853 |                    197 / 1,009 / 3,808 |                   228 / 1,558 / 4,930 |
| Proximity        |      71 |          68 / 176 / 270 |                        177 / 436 / 698 |                     188 / 461 / 1,041 |
| Nonempty results |     137 |          92 / 185 / 853 |                      225 / 653 / 3,808 |                     241 / 973 / 4,930 |
| Zero results     |      43 |          34 / 180 / 273 |                       94 / 513 / 2,822 |                     102 / 512 / 1,558 |

The planner used selective execution for 68 queries, document packages for 50,
membership-blocks for 47, block-max MAXSCORE for 12, and complete-term execution
for three. Forty-four queries still need at least 50 score I/O phases. Overall
phase P50/P95/P99 is 31/60/61. Phases count score fetches requiring shared/origin
I/O, not all logical calls or all dependent query operations.

### Expensive scenarios

| Query (short label)                                                | Returned | CPU ms | Reused application ms | Empty application ms | Score I/O phases |
| ------------------------------------------------------------------ | -------: | -----: | --------------------: | -------------------: | ---------------: |
| Requests for admission + application of law / legal conclusions    |       20 |    858 |                 4,008 |                5,269 |               61 |
| Mandate rule + discovery / law of the case + timeliness            |        4 |    853 |                 3,808 |                4,930 |               60 |
| Statute of limitations + affirmative defense + Rule 16 + diligence |       19 |    397 |                 1,886 |                3,183 |               61 |
| Civil Rights Act of 1960 + voter records + statement of the basis  |        0 |    273 |                 2,822 |                1,558 |               58 |
| Second Amendment W/P one handgun / purchase limits                 |        0 |    270 |                   622 |                  676 |               47 |

These labels abbreviate the original Boolean expressions. The CSV contains every
full executed query and its original identity. Returned counts are capped at 20;
exact totals were not requested.

Requests-for-admission CPU ranges from 847–900 ms, mandate rule 828–856 ms across
the three no-delay observations. Their reused-application response ranges are
3,976–4,028 and 3,807–3,851 ms respectively. The statute query is less stable:
1,806–3,217 ms reused and 1,854–3,194 ms empty-application. Cache operations and
read counts vary with condition order and earlier reads.

### Main findings

1. **The worst CPU costs are repeated checksum work coupled to large reads.**
   CRC32 accounts for 73.9% of sampled time on requests for admission and 76.4%
   on mandate rule, including idle and sampling overhead in the denominator.
   Warm application runs still perform median 571/557 origin reads and transfer
   141.5/144.2 MB from the simulated origin, plus 179.7/174.5 MB from shared cache.
   They record 955/896 shared-budget bypasses. The Reader has a combined budget
   of 900 shared operations, including puts. Once exhausted it bypasses shared
   reads, and origin data is validated again. Warm namespaces do not imply zero
   origin reads or a fully populated cache. This is observed in the local model;
   native speedups from changing it have not been established.

2. **Selective labels do not guarantee selective score work.** Requests for
   admission decodes 2,251,844 score postings for 2,294 candidate checks; mandate
   rule decodes 1,952,997 for 1,204 checks. They retain 61/60 score I/O phases and
   zero successful prefetch windows. The current lookahead excludes a selected
   membership mask; other windows can exceed the transfer cap. Fetching and
   validating large volumes through sequential numeric windows remains costly.

3. **Zero-hit proximity rejection has a different CPU problem.** The Second
   Amendment query makes zero origin reads but decodes 1,504,930 score postings
   and 854,043 position integers for 24,631 candidate checks. Its search closure
   consumes 26.3% of sampled time, followed by storage key construction at 8.6%,
   format closures at 7.5%, and packed column decoding at 6.6%. Heap sampling
   estimates about 291 MB of cumulative allocation per response. This is not
   retained or peak memory. A full top-K heap cannot help a query with no matches;
   candidate rejection and positional scanning need their own efficient path.

4. **Directory and plan construction create substantial allocation.** Across
   all allocation samples, `decodeDirectoryBlock` contributes 20.1%, `leaves`
   8.3%, `subarray` 7.2%, and anonymous search closures 6.3%. This is sampled
   cumulative allocation across two responses/query, not a native memory limit
   assessment. The CPU sampler also attributes 12.8% of aggregate sample time
   to inspector `post` calls: short-query profiles have visible harness overhead.
   Use the separate no-delay process CPU measurements for timing conclusions.

5. **Result retrieval is not the main cost for the worst two scenarios.** Their
   metadata/excerpt stages take medians of 87 and 28 ms with application reuse,
   versus 4,008 and 3,808 ms for complete responses. This round leaves rendering
   unchanged and does not propose excerpt optimization.

Condition ordering is randomized but the two timed conditions share the same
per-query primed namespace. The first timed request can populate shared data for
the second. The single priming pass is also subject to the 900-operation budget;
it does not fully warm every large query. Thus the counterintuitive Civil Rights
cache ordering is an observation of these bounded, partially populated states,
not evidence that clearing application memory improves the engine. A follow-up
comparison should use independent, equally primed shared states for each variant.

## Recommendation

Prioritize physical read amplification and shared-operation budgeting together
with candidate-window batching. Preserve validation: avoid rereading validated
pages, reserve shared reads before optional writes exhaust the budget, and batch
score reads across sorted candidate windows where the footprint permits. Do not
simply raise the shared-operation budget or remove checksums. The two worst
scenarios give concrete controls for CPU, origin bytes, budget bypasses and
score dependencies.

Next, address directory/leaf allocation and the zero-hit positional path using
the Second Amendment and Civil Rights queries. Keep candidate generation and
verification exact. The broad-query cost here is not solved by better top-K
ranking bounds alone.

Machine-readable results, all 180 original/executed queries, per-query counters,
and all 360 compressed profiles are in `results/columnar/research-180-1m/`.
`queries.csv` is the compact per-query view; `summary.json.gz` includes attribution
and full per-condition statistics. The scripts pass TypeScript and Prettier
checks. Production source files are unchanged from `d51e79b`.
