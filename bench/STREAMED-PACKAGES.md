# Streamed candidate packages on the local 1M corpus

This iteration compares the unchanged `eb7a376` runtime with bounded document-package execution. Everything runs against the existing local stemmed 1M generation, N=100/M=1000, with simulated I/O. No Cloudflare operations or downloads. Index bytes, context, scoring formula, sorted membership representation and excerpt algorithms are unchanged.

The package executor no longer rejects an execution because its cumulative transfer exceeds 8 MiB or it has more than 512 candidates. It streams sorted candidate IDs in batches of at most six packages and 4 MiB of raw bytes, measured from actual locators. An individually larger package runs alone, rather than losing a document. Winner raw bytes have an independent 4 MiB retention budget; evicted winners may be fetched again for rendering. Decoded frequency/token arrays and rejected packages are released between candidates. Rendering is scheduled in bounded batches using the existing rendering code.

Automatic selection prices actual candidate package lengths before their I/O. It compares transfer, GET/wave estimates and the physical page envelope of blocks whose document-ID spans overlap candidates, rather than logical posting bytes. Layout inspection walks eight document windows at a time; it never assembles a flat corpus-wide posting plan. If package work already beats the estimated score-wave cost, it avoids remote layout discovery. A loose whole-list page estimate stops pricing enormous losing candidate prefixes. All these estimates choose between complete exact executions; none truncate candidates or justify pruning.

Unigram and existing positional-pair anchors are repriced after their real intersection is known. This matters: simply removing the old runtime guard let a plan estimated at 348 candidates open 6,402 packages / 390 MiB, taking about 23 seconds warm. That experiment was rejected. The shared cost check now rejects that document continuation before any candidate package is opened, and ordinary exact postings execution completes the query, retaining the complete sorted anchor intersection. A losing pricing prefix is never used as a candidate cutoff.

## Measurement

The forced-path experiment materializes and hashes a canonical sorted candidate list after the same membership/presence filters. Both forced continuations consume precisely those IDs. This materialization is harness-only; serving uses sorted membership cursors. Complete responses include metadata, matching snippets and JSON serialization, without response caching.

The model is 20 ms + bytes/100 MiB/s for origin, 2 ms + bytes/1000 MiB/s for shared cache, six source slots, 12 MiB application pages, 4 MiB decoded cache and 1 GiB simulated shared cache. Measured requests retain the 900-operation cache budget. Untimed priming uses a high simulation-only budget so shared-warm observations distinguish budget bypasses from misses. Fresh namespaces clear both simulated cache layers; they do not represent actual deployment startup or opaque R2 backend caches.

Jobs are randomized/interleaved. Workloads remain separate. Reported medians/ranges are pilot measurements, not production percentiles or P99 estimates. Process CPU observations during simulated waits include process GC and are not isolated CPU profiles.

Four samples per query/version/condition: **312 measured responses** across 13 queries and three conditions. Shared-warm means cleared application caches. Reuse below is a randomized mixed 13-query workload with persistent bounded application caches. Bytes include origin plus shared response bytes, including repeats.

Arrows below are frozen control → automatic execution.

| Query        | App reuse, ms | Shared warm / app empty, ms | Both empty, ms | Both-empty transfer, MiB |
| ------------ | ------------: | --------------------------: | -------------: | -----------------------: |
| Admission    |     606 → 261 |                   600 → 266 |    4547 → 1539 |           202.06 → 37.87 |
| Mandate      |     245 → 156 |                   252 → 151 |     1416 → 921 |            75.06 → 12.76 |
| Rule 41(b)   |     225 → 144 |                   221 → 150 |    1515 → 1030 |             44.07 → 8.64 |
| Civil Rights |     711 → 412 |                   715 → 419 |    4871 → 2411 |           208.86 → 57.45 |
| Price impact |     120 → 189 |                   126 → 191 |     812 → 1049 |            17.70 → 27.03 |

The separate forced experiment has three samples per query/path/condition: **162 measured responses**, on nine identical candidate sets. The automatic planner retains postings for the six cases where forced packages lose in at least one cache condition.

Arrows in this table are forced postings → forced document packages.

| Query / candidates                               | Forced shared warm, ms | Forced both empty, ms | Both-empty GETs | Data fetch waves | Accounted active buffers, MiB |
| ------------------------------------------------ | ---------------------: | --------------------: | --------------: | ---------------: | ----------------------------: |
| "consent decree" / 1790                          |             131 → 3935 |            930 → 7215 |       78 → 1791 |         27 → 299 |                   3.26 → 4.00 |
| "facial challenge" / 502                         |              171 → 311 |           1063 → 2252 |       122 → 504 |          29 → 84 |                   3.99 → 3.54 |
| "qualified immunity" W/P "First Amendment" / 960 |              181 → 752 |           1184 → 3919 |       125 → 962 |         34 → 160 |                   4.21 → 2.25 |
| "Rule 41(b)" / 227                               |              223 → 148 |           1527 → 1035 |       171 → 230 |          44 → 38 |                   4.55 → 1.64 |
| corporation / 497                                |              151 → 339 |            913 → 2200 |       113 → 498 |          23 → 83 |                   4.46 → 2.16 |
| "Rule 16" / 576                                  |              291 → 328 |           1928 → 2495 |       267 → 578 |          52 → 96 |                   4.89 → 2.75 |
| "requests for admission" / 264                   |              601 → 221 |           4540 → 1303 |       792 → 269 |          80 → 44 |                   6.69 → 2.98 |
| "Rule 26(f)" / 575                               |              352 → 324 |           2322 → 2440 |       376 → 577 |          54 → 96 |                   5.75 → 1.63 |
| "mandate rule" / 193                             |              242 → 153 |            1397 → 923 |       217 → 194 |          33 → 33 |                   4.97 → 1.42 |

Data waves here count awaited score, position, anchor and package batches that performed cache/origin I/O. They exclude plan/directory discovery and rendering; they are not the complete I/O dependency DAG. The main frozen runtime lacks the added position-wave counter, so this comparison uses the forced postings path with identical execution plus instrumentation. Process CPU, block/posting and position/token decoding, per-query ranges, cache counters and rendering cost are in the raw rows and summaries.

The automatic path has real planning overhead. Admission's forced document path is 221 ms warm / 1,303 ms empty, while automatic execution is 266 / 1,539 ms. Detailed page inspection adds about 3.8 MiB of metadata transfer. These are different randomized pilot sessions, not paired subtraction estimates, but the extra reads are directly counted. Mandate and Rule 41(b) avoid that layout-discovery stage through the score-wave estimate.

Price impact remains a clear selection regression: the warm sample ranges are 119–130 ms for control versus 180–193 ms for automatic execution. Its 208 packages contain about 2.1M body tokens and transfer more bytes than postings. The planner's band/wave estimate overprices a cheap unigram rejection path. Other shared-warm pilot median increases are Rule 26(f) 347 → 369 ms, corporation/client-file 157 → 169 ms, consent decree 129 → 148 ms and Small Business Administration 257 → 272 ms. Some ranges overlap; these need longer retiming before assigning precise effect sizes. Their raw ranges and work counters are retained. The 227 query's historical per-query-reuse slowdown did not reproduce in this mixed-workload comparison: 84 → 79 ms shared warm and 492 → 414 ms empty. It still transfers more package bytes.

Civil Rights no longer runs the speculative score lookahead: its document continuation performs zero score-block reads. This resolves this query's traffic regression through path selection; the general lookahead scheduler is unchanged.

Initial locator inventory for the targets:

| Query     | Packages | Total MiB | Median package KiB | P95 KiB | Maximum MiB |
| --------- | -------: | --------: | -----------------: | ------: | ----------: |
| Admission |      264 |     33.50 |              78.27 |  516.91 |        1.39 |
| Mandate   |      193 |     12.66 |              46.31 |  196.00 |        0.63 |

For the forced shared-warm path, observed process CPU is admission 404 → 199 ms, mandate 156 → 115 ms and Rule 41(b) 145 → 68 ms. These are process observations including local cache transfers and GC, not isolated CPU attribution or Worker CPU measurements. Admission's block-score decoding is 305,024 → 0 postings; initial membership/presence decoding remains, and package execution decodes 535,656 forward token integers. Mandate instead trades 15,356 score postings and 5,733 posting-position integers for about 1.0M forward token integers. This trade helps latency here but is another reason candidate count alone is insufficient.

The next experiment should read the existing numeric sections independently, with a measured header/discovery-wave cost. Untimed header inspection shows header plus frequency/token bytes of **8.18 versus 33.50 MiB** for admission, **3.19 versus 12.66 MiB** for mandate, **13.20 versus 53.52 MiB** for Civil Rights, and **6.45 versus 26.37 MiB** for price impact. These are byte potentials, not measured range-read speedups. Retain cheap complete-frequency rejection before opening candidates, especially for price impact; budget GETs and dependent phases alongside bytes. No new index representation is needed to test this. This iteration is useful local 1M evidence, not a final automatic planner or evidence of Worker/10M readiness.

## Memory and correctness

Package buffer accounting deduplicates raw winner/batch references, adds live decoded numeric arrays and estimates position-array entries at eight bytes each. It is neither cumulative allocation nor peak heap: matcher objects, JS array slack, GC, inflated text, candidate/plan bookkeeping and separate bounded caches are outside this metric. The batch/winner budgets bound retained raw package work; an oversized individual document and its decoded arrays are explicit exceptions.

All **270 tests in 73 files** pass with `yarn test --maxWorkers=1 --testTimeout=120000`; typechecking and formatting pass. The default suite timed out once in unchanged `global-fine.test.ts`; it passed alone, then the full serial suite passed with a longer per-test timeout. The 160 independent source-oracle scenarios pass. All 180 rewritten research queries preserve ranked IDs/order and metadata: 177 full responses are identical; three contain only score differences of 3.55e-15. The separate cursor check covers ten queries using both control-issued and current-issued cursors. New tests cover >512 candidates, exact totals, Boolean/negative/proximity/field behavior, ranking/ties/pagination, oversized singleton batches, physical-page pricing and preserving the complete sorted candidate intersection after a losing package forecast.

Raw results, source/corpus/configuration provenance, per-query medians/ranges and validation are in [the result directory](results/columnar/streamed-packages-1m/summary.json). The frozen control is retained separately and reproduced by the existing control freezer. All runs record zero downloads. Raw validation timing is not used as a performance comparison.

## Reproduction

The corpus, complete pair packets and local R2 mirror must already exist. Commands below do not enable preparation, uploads or remote access.

```sh
yarn node --import tsx bench/columnar/freeze-cpu-control.ts eb7a376
CWS_VARIANTS=postings,documents CWS_REPEATS=3 CWS_SEED=20261129 \
yarn node --import tsx bench/columnar/stream-packages.ts \
work/columnar-worker-stem-1m work/columnar-complete-pairs-1m \
bench/results/columnar/streamed-packages-1m/forced-contract.json \
work/stream-packages/forced-final.json.gz
```

For the frozen runtime comparison:

```sh
CWS_CONTROL_SOURCE=work/cpu-control-eb7a376 CWS_CONTROL_RUNTIME=frozen \
CWS_PAIR_INDEX=work/columnar-complete-pairs-1m \
CWS_PLANS=control-N100-M1000,auto-N100-M1000 CWS_SHARED_CACHE_MIB=1024 \
CWS_PRIME_SHARED_BUDGET=1000000 CWS_REPEATS=4 CWS_SEED=20261130 \
CWS_CONDITION=shared-warm-memory-empty CWS_LABEL=stream-final-shared-warm-memory-empty \
yarn node --import tsx bench/columnar/simulate.ts \
work/columnar-worker-stem-1m bench/results/columnar/streamed-packages-1m/contract.json
```

Repeat with `memory-reuse` and `fresh-namespace`. Raw manifests retain source/control hashes, corpus/generation identities, router identity, query contract, seed, model and cache budgets. `inspect-packages.ts` records locator sizes and reads the largest package headers locally; `report-stream-packages.ts` produces per-query medians and min/max rather than pooling workloads.
