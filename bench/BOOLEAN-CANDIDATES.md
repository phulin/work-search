# Boolean candidates before scores

Implemented against `0a72b2c` on the local stemmed 1M corpus, using N=100/M=1000. No Cloudflare operations, downloads, format changes, context changes, stemming changes, bitmap postings, scoring changes, or excerpt-code changes. Complete responses include metadata, query-relevant snippets and JSON serialization; response caching is disabled.

The main improvement is conservative pair evidence through the positive Boolean tree. AND intersects available evidence, OR unions evidence only when both branches have coverage, and exclusion retains only its positive side. Unknown evidence remains unrestricted; a conservative negative set is never subtracted. Proximity combines body and title evidence separately. Exact phrase/proximity verification still decides membership, and only verified matches raise ranking thresholds.

Selected phrase packets are scheduled together with necessary term metadata and common-word filters in the initial parallel wave. Common-word filters are skipped only for words proved on every surviving branch. Pair choices are made before I/O against the existing complete-term/document/block alternative. For compound queries with expensive block alternatives, bounded unknown-pair probes address the unreliable tail-DF prior: at most one unknown packet of <=256 KiB per phrase, with a combined 8 MiB multi-branch cap. These probes do not apply to standalone phrases; applying them there regressed “burden of proving” and was rejected. Estimates only schedule work; actual sorted memberships constrain every continuation, including block fallback. Existing document-package limits remain 512 candidates and 8 MiB total.

Candidate-aware lookahead uses the same filtered document windows as execution. Consecutive score-ref groups are prefetched only when multiple complete windows fit `min(4 MiB, page-cache budget / 3)`. Oversized windows use ordinary execution. A partial-prefix prefetch trial added waves/traffic and was rejected. Position payloads are never prefetched by this scheduler. Sorted membership cursors remain the posting representation; lookahead reuses the existing small window masks. Ranking bounds, float64 buffers, tie ordering and exact-total rules are unchanged.

Measurements below are local Node diagnostics with modeled origin latency of 20 ms + bytes/100 MiB/s, shared-cache latency of 2 ms + bytes/1000 MiB/s, six I/O slots, 12 MiB application pages, 4 MiB decoded cache, and 1 GiB simulated shared cache. The unchanged 900-operation shared GET/PUT budget applies per request. Origin reads caused by that budget are reported as implementation-induced bypasses, not ordinary cache misses. No claim is made about opaque R2 caches or native Worker performance.

| Query                                                  | Application reuse, ms | Empty application / primed shared, ms |  Score postings decoded | Score I/O waves | Isolated process CPU, ms |
| ------------------------------------------------------ | --------------------: | ------------------------------------: | ----------------------: | --------------: | -----------------------: |
| Requests for admission + OR phrases                    |       3,050 → **678** |                       2,977 → **692** | 2,251,844 → **305,024** |     61 → **44** |            289 → **183** |
| Mandate rule + Boolean branches                        |       2,699 → **232** |                       2,715 → **232** |  1,952,997 → **15,356** |     60 → **27** |             282 → **78** |
| Second Amendment proximity                             |          706 → **18** |                          707 → **20** |       1,504,930 → **0** |      47 → **0** |             283 → **13** |
| Statute of limitations / affirmative defense / Rule 16 |          905 → **79** |                          881 → **77** |       1,509,180 → **0** |      61 → **0** |             243 → **48** |
| Burden of proving                                      |             207 → 210 |                             222 → 222 |       171,904 → 171,904 |         10 → 10 |                  48 → 48 |
| `(rules OR of) AND rule`                               |              98 → 104 |                             105 → 106 |       226,304 → 226,304 |           8 → 8 |                  66 → 64 |

Latency cells are medians of six randomized/interleaved samples per query/version/condition, including cache convergence after bounded priming. These are pilots, not traffic percentiles or useful P99 estimates. Raw rows and summary min/max are archived. CPU is measured separately without artificial delays or inspector, across two independent process pairs, ten randomized/interleaved requests per version/query/session after five warmups. It includes each process’s own GC and deferred cache work. Do not subtract these CPU numbers from the latency cells.

The ablations isolate the mechanisms: branch filtering reduces admission score postings to 305,024 and score I/O waves from 61 to 49; candidate-aware lookahead then reduces waves to 44 without changing decoded postings. Mandate waves go 60 → 48 → 27. Second Amendment needs no score reads after branch filtering. Its one document-package candidate is rejected. Mandate’s numeric candidate checks fall 1,204 → 6; admission’s fall 2,294 → 262.

Physical amplification was measured separately without artificial delays. An optional Reader hook records post-cell-filter block lists, restricted to refs actually scheduled. A separate diagnostic read checks actual posting IDs against the candidate IDs: block address spans alone overstate overlap. Pages below are the unique aligned page envelope of those refs, not observed cache transfers or a proof that every block is necessary after exact matching.

| Query                  | Candidate-overlapping score blocks | Extra blocks admitted by cells | Overlapping block bytes, MiB | Page envelope: overlapping / all, MiB |
| ---------------------- | ---------------------------------: | -----------------------------: | ---------------------------: | ------------------------------------: |
| Admission, control     |                             16,462 |                          5,877 |                        35.75 |                         91.25 / 91.50 |
| Admission, replacement |                              2,323 |                          1,276 |                         5.05 |                         80.75 / 81.00 |
| Mandate, control       |                             14,708 |                            735 |                        32.16 |                         65.75 / 65.75 |
| Mandate, replacement   |                              1,026 |                            766 |                         2.24 |                         57.00 / 57.00 |

Eliminating every coarse-cell-only block would save just one page for admission, and none for mandate. Sparse useful blocks on many physical pages dominate this residual amplification. Admission’s observed score-stage origin+shared transfer drops 95.25 → 81 MiB; repeated shared score transfers drop 2 → 0 MiB, and repeated origin range calls 4 → 0. Repeated score decoding drops about 169 → 4.6 KiB. Mandate’s repeated score decode is about 399 → 54 KiB; its remaining score transfer is 56.75 MiB. The old Second Amendment path has no candidate mask, so a candidate-overlap breakdown is inapplicable; it decodes 11,400 unique score blocks versus zero afterward. All raw accounting, including repeated decoded bytes and refs outside the candidate hook, is retained.

The cache-budget ablation primes the same shared pages with a high simulation-only budget, empties application caches, then varies only the measured operation budget. Three interleaved samples per version/query/budget:

| Query     | Control: budget 900 → high, ms | Replacement: budget 900 → high, ms | Control origin reads at 900 → high |
| --------- | -----------------------------: | ---------------------------------: | ---------------------------------: |
| Admission |                    2,937 → 884 |                          587 → 583 |                            383 → 0 |
| Mandate   |                    2,654 → 924 |                          239 → 234 |                            341 → 0 |

The budget cliff explains much of the control’s apparent warm latency; pair filtering still wins after removing it. Production limits were not increased.

With fresh application/shared namespaces, three samples per query/version, admission remains **7,063 → 4,625 ms**, mandate **7,140 → 1,434 ms**, and Second Amendment **4,758 → 79 ms**. Admission still transfers about **195 MiB** and makes **792 origin reads**. These are empty simulated namespaces, not isolate/deployment startup measurements.

The 180-query historical regression screen used the same nine finite OR rewrites for `!` queries. Every ranked document ID/order and metadata value is preserved. 176 complete-response hashes match; three other queries have only float64 recomputation differences, at most 7.11e-15, and one chooses a different relevant passage in two results. These are pre-existing differences between document-package and block execution, whose code was not changed. Normal FP error is accepted; the existing oracle score tolerance passes. Full responses for these cases are archived rather than silently normalizing them.

The screen is three historical samples versus one new sample per condition; it is not an interleaved latency estimate. Six suspicious cases were therefore retested with five randomized/interleaved samples in each cache condition and two isolated CPU sessions. Protective order improves **708 → 487 ms**, IDEA **264 → 188 ms**, consent decree **180 → 130 ms**, Title IX **290 → 227 ms**, and forum selection **173 → 123 ms** with application reuse. CPU trades remain: Title IX **62 → 65 ms**, forum selection **37 → 42 ms**, and Civil Rights **210 → 222 ms**.

Civil Rights regresses **779 → 911 ms** during bounded shared-cache priming, with unchanged score postings and 58 score I/O waves. Lookahead adds transfers and triggers more budget bypasses while caches converge. A separate seven-sample interleaved run with completely primed shared pages, empty application caches and the unchanged measured budget shows **747 → 708 ms**, with zero origin reads on both versions. Shared GETs rise **834 → 874** and shared bytes **199.61 → 208.86 MiB**. Thus lookahead has a real CPU/traffic cost even when latency improves; it should next price cache residency and avoid speculative reads that do not reduce dependent score waves.

Validation includes the full Yarn test suite, typechecking, formatting, 160 independent source-oracle scenarios, exhaustive small-corpus Boolean/field/phrase tests, adversarial unknown OR branches and negatives, ties/pagination/exact totals, and a local workerd Boolean-membership fixture. All experiments use local bytes and record zero downloads. See [machine-readable results](results/columnar/boolean-candidates-1m/summary.json), [CPU sessions](results/columnar/boolean-candidates-1m/cpu-summary.json), and [cross-path response differences](results/columnar/boolean-candidates-1m/response-differences.json.gz).

Next: test bounded, streamed candidate-document verification beyond the current **8 MiB total** cutoff, budgeting active batches and retained winners separately. Price it against physical page footprints rather than logical posting bytes. Admission has only 264 membership candidates yet still transfers 195 MiB in a fresh namespace; improving this continuation is more promising than another ranking-bound rewrite. Keep stored score completion available where exact contributions are needed. This is a local improvement, not evidence of readiness for full-corpus adoption.

Reproduce using Yarn (the corpus and pair index must already be local):

```sh
yarn node --import tsx bench/columnar/freeze-cpu-control.ts 0a72b2c
CWS_CONTROL_SOURCE=work/cpu-control-0a72b2c CWS_CONTROL_RUNTIME=frozen \
CWS_PAIR_INDEX=work/columnar-complete-pairs-1m \
CWS_PLANS=control-N100-M1000,auto-N100-M1000 CWS_SHARED_CACHE_MIB=1024 \
CWS_REPEATS=6 CWS_SEED=20261123 CWS_CONDITION=memory-reuse \
CWS_LABEL=boolean-final-reuse yarn node --import tsx bench/columnar/simulate.ts \
work/columnar-worker-stem-1m bench/results/columnar/boolean-candidates-1m/contract.json
```

Use `shared-warm-memory-empty` for empty application caches and `fresh-namespace` for empty application/shared namespaces. `CWS_PRIME_SHARED_BUDGET=1000000` changes priming only; `CWS_SHARED_BUDGET` changes the measured simulation budget (default 900). The result manifests retain code/corpus/generation identities, settings, query contracts, cache conditions, seeds and models. The branch-only control is retained separately with its base revision and source overlay; it is not a production execution option.
