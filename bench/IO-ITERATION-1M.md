# Pair intersections and rolling packages on 1M

2026-11-14. This implements the first two steps of the live-profile follow-up: cost-based pair eligibility and early intersections, then a rolling document-package pipeline. It improves arbitration substantially, but does **not** resolve the common-phrase path or establish a general latency win. The serving Worker was not promoted. Format, index generation, context, excerpts, scoring, and cache policy are unchanged; lists remain sorted, with no bitmaps.

## Changes

- Top-M pairs are candidates for costing even when their phrase includes an ordinary word. The old eligibility gate no longer eliminates every pair of `"in the absence of"` before costing. N=100/M=1000 remains the baseline.
- Price pair selectivity relative to the existing selective unigram plan, conditioning on a shared anchor. Corpus-wide pair DF larger than an existing candidate count is no longer mistaken for zero incremental selectivity. Estimates influence cost only; exact memberships determine coverage.
- Read necessary selective unigrams alongside pair packets in the first parallel wave, intersect their sorted numeric candidates before pricing the continuation, and reuse that result in document or block execution. Skip unigram and common-word reads already proved by the selected pairs.
- Replace six-package `Promise.all` barriers with a rolling pipeline. Refill a slot when an individual package completes, process completion order, and retain deterministic ranking independently of completion order. Reserve raw bytes for pending, ready, and currently consumed packages together: 4 MiB, with an oversized package alone. Winner retention remains separately bounded at 4 MiB. Error/early-exit paths drain outstanding reads.
- Keep six requests through body consumption for this experiment. This is deliberately more restrictive than Cloudflare's limit: the documented six-connection limit applies while waiting for headers, and releases a connection once headers arrive. Separate header and buffered-body budgets are future work. [Official limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections).

For arbitration, the three pair packet reads total 285,817 bytes (279 KiB). Their intersection with the necessary `arbitration` unigram produces **94 candidates**, versus the old anchor/presence path's 714. The selected pair already proves `beneficiary`, so its extra unigram packet is omitted. The physical continuation now costs 9.74 MiB of candidate packages, and the planner chooses documents instead of broad posting pages. Exact verification retains all 94 matches, including the requested exact total.

## Live final arbitration comparison

Client times include complete response bodies, metadata and snippets, without response caching. Each cell is a median of **three** requests. Fresh means fresh application/shared-cache identity, **not** control over R2's opaque backend caches or a guaranteed new isolate. Warm means one preceding same-query request in the same namespace, with application memory reset **inside** the measured search request.

| Measurement                               |              Control |    Final candidate |
| ----------------------------------------- | -------------------: | -----------------: |
| Fresh client latency                      |   8.97 s (5.19–9.22) | 1.96 s (1.81–3.02) |
| Shared-warm / empty app latency           |   2.36 s (2.17–2.41) | 1.22 s (1.22–1.34) |
| Fresh native CPU                          | 1,398 ms (775–1,453) |   506 ms (388–696) |
| Shared-warm native CPU                    |     592 ms (523–636) |   395 ms (289–468) |
| Fresh R2 GETs                             |                  270 |                 98 |
| Fresh R2 bytes                            |            75.88 MiB |          10.51 MiB |
| Shared-warm cache reads                   |                  326 |                 99 |
| Score postings decoded                    |              413,329 |                  0 |
| Total postings decoded, including anchors |              454,706 |            320,244 |
| Positional I/O waves                      |                   56 |                  0 |
| Candidate packages                        |                    0 |                 94 |

The candidate still decodes 306,182 pair-membership integers and 782,189 forward integers. It has **94 package loads**, not zero I/O dependencies. Zero positional waves means this query uses the package path. Likewise `packagePipelineWaits` counts awaited completions, not serialized network round trips. Legacy batch-wave counters no longer describe this executor. Peak raw pipeline reservations were about 2.1 MiB in this final latency run; peak tracked active buffers about 4.2 MiB. These counters exclude uninstrumented VM/runtime allocations and are not native peak memory measurements.

The control varied considerably: the preceding broad pilot measured arbitration at 5.35 s fresh / 2.56 s shared-warm, versus 2.31 / 0.84 s for the candidate before the redundant unigram read was removed. Both sessions support lower necessary work; they do not establish production percentiles or a precise speedup multiplier.

## Broad live pilot and regressions

Three randomized/interleaved sessions per query and cache condition: 96 complete responses. This candidate version precedes only the final redundant-unigram-read removal; the other paths are unchanged. Do not combine it silently with the final version above.

| Query                                   | Fresh control → candidate | Shared-warm control → candidate |
| --------------------------------------- | ------------------------: | ------------------------------: |
| Requests for admission                  |             5.03 → 3.75 s |                   2.85 → 1.51 s |
| Mandate rule                            |             3.38 → 3.88 s |                   1.21 → 1.12 s |
| Trade secret / reasonable measures      |             1.59 → 1.83 s |                   0.72 → 0.45 s |
| Clear error / credibility determination |             4.70 → 5.55 s |                   2.22 → 2.12 s |
| In the absence of                       |           11.94 → 16.69 s |                 11.61 → 10.16 s |
| Forum selection                         |             0.97 → 1.30 s |                   0.54 → 0.73 s |
| Reasonable expectation /25 privacy      |             5.44 → 5.60 s |                   1.30 → 1.41 s |

Admission keeps the same 264 packages and exact results; 44 fixed batch barriers are replaced by rolling reads. Its larger active working set is deliberate: tracked buffers rose from 2.98 MiB to at most 4.86 MiB in this pilot. Mandate keeps 193 packages, replacing 33 barriers. Neither has fewer package GETs simply because its scheduling improved. Cold regressions show that removing barriers alone is not a universal win.

The common-phrase planner now considers its pairs but **still declines them**. Absence therefore retains the same 799 origin GETs / 195.31 MiB in the broad pilot. Its early candidate CPU samples were higher (cold median 2,675 versus 1,679 ms), despite unchanged decoded work; the samples do not identify the cause. Forum selection also retained exactly 26 GETs and the complete-term plan. A final-version recheck found fresh latency 1.21 → 1.17 s and warm latency 0.59 → 0.63 s; cold CPU remained higher, 235 → 351 ms, while warm CPU was 275 → 247 ms. The initial latency regression is not stable across sessions; the cold CPU difference remains unexplained. These results argue against broad promotion or 10M adoption now.

## Small controlled-arrival pilot

Final version, shared pages primed, application reset per request. Three workload classes cycle: arbitration, admission, and the unfamiliar forum-selection query. Each rate/variant has **20 attempts**, including drain. All 80 passed exact response checks; native CPU observations joined all requests. No HTTP/transport errors or native non-OK outcomes were recorded in this rerun.

| Arrival rate | Query           | Control median | Candidate median |
| ------------ | --------------- | -------------: | ---------------: |
| 0.5 req/s    | Arbitration     |         2.34 s |           0.74 s |
| 0.5 req/s    | Admission       |         1.60 s |           1.22 s |
| 0.5 req/s    | Forum selection |         0.56 s |           0.62 s |
| 2 req/s      | Arbitration     |         2.23 s |           0.57 s |
| 2 req/s      | Admission       |         1.41 s |           1.12 s |
| 2 req/s      | Forum selection |         0.69 s |           0.51 s |

At 2 req/s, peak client in-flight requests were five/control and three/candidate. Maximum launch lag was under 3 ms. Finite-burst throughput including drain was 1.82/control and 1.88/candidate requests/s. These are client overlap/dispatch observations, not server queue depth, steady-state capacity, or useful P99 estimates. Load phases alternate variant order; individual requests within a phase use one variant. Only one client region was available.

The earlier broad pilot's first control load phase aborted after one of 20 attempts failed without a saved HTTP response; 19 succeeded. Its driver lost the error detail, so its cause is **unknown**. Error capture now retains transport failures, non-JSON responses, status, request IDs and response details, and continues other load phases. The rerun above completed. The failed pilot remains archived and is not counted as zero errors.

## Local comparisons and correctness

Independent caches per query/variant/repetition; warm conditions get one untimed same-query priming pass. Randomized interleaving, three measured repetitions. Model: 50 ms R2 + 0–30 ms jitter, 100 MiB/s; 8 ms shared cache, 1,000 MiB/s; 256 MiB shared LRU; unchanged 900-operation budget. Local process CPU is diagnostic and includes instrumentation; it is not Worker CPU.

| Query                             | Simulated fresh control → candidate | Simulated shared-warm control → candidate |
| --------------------------------- | ----------------------------------: | ----------------------------------------: |
| Arbitration, final version        |                    6,775 → 1,347 ms |                              929 → 172 ms |
| Admission                         |                    4,635 → 4,095 ms |                              563 → 515 ms |
| Mandate                           |                    3,009 → 2,580 ms |                              356 → 320 ms |
| Burden of proving                 |                    4,532 → 4,529 ms |                              641 → 650 ms |
| In the absence of                 |                  15,459 → 15,432 ms |                          7,922 → 8,050 ms |
| Mixed negative jurisdiction query |                    4,029 → 4,023 ms |                              599 → 619 ms |

The ten-query local sweep predates only the final redundant-anchor omission; arbitration was rerun separately on the final code. Absence's modeled warm request still performs 88.22 MB of origin reads after the budget/eviction behavior. It is not an all-pages-warm test. No simulated timings are presented as live measurements.

- `yarn run check` and formatting passed. `yarn test`: **293 tests across 79 files passed**, including out-of-order package completion, error draining, memory reservations, exact totals, score ties, search-after, fields and negative positional matching.
- **200 queries** (the existing rewritten 180 plus 20 unfamiliar queries): 400 control/candidate complete responses, identical semantic hashes covering ranked IDs/order, totals, metadata and snippet strings. Scores separately pass the existing FP tolerance. This comparison supplements rather than replaces the independent oracle.
- **160-query independent oracle** passed on final code.
- All 96 broad live responses, 104 final latency/priming/load responses, and 12 unfamiliar recheck responses passed ranked IDs, score tolerance, exact rendering and requested exact totals.
- Nine additional live generic-metadata/search-after checks passed, including the 43-hit filter, its 36 remaining hits after the seven-hit cursor, and the zero-hit filter.

## Rejected experiments and next work

Naively multiplying pair selectivities made correlated common-connector pairs look cheap and regressed burden. A blanket correlation penalty then removed useful supplementary admission filters, increasing its candidates from 264 to over 400. The retained rule prevents a top-M combination from inventing a profitable primary anchor through independence across a ubiquitous connector, while preserving supplemental filters on an already worthwhile anchor. This is a cost heuristic, never a correctness shortcut.

A forced absence pair experiment reduced transferred bytes but roughly doubled local no-delay CPU; its apparent warm latency benefit was confounded by cross-query/cache progression. It is not retained. Cache isolation was repaired before the accepted sweeps. The /128 positional-work prior remains uncalibrated and is a specific remaining planner limitation; simply making every excluded pair profitable is not justified.

Next: measure absence's eligible pair alternatives against the actual filtered physical footprint and decoding cost, then add candidate-aware positional lookahead with explicit byte reservations and retain-until-consumed buffers. Preserve the rolling pipeline while separately testing header/body concurrency. After those, compare stable sparse ranges/coalescing with full pages and cache identities. Adaptive cache budgets remain last. No new format or context/excerpt change is needed for these experiments. Significant unfamiliar-query and sustained-load validation is still required before a serving rollout, larger samples, or 10M construction.

## Reproduction and artifacts

Control repository commit `3129497` (engine behavior unchanged from `545306b`); control Worker version `177b51f3-545b-4a15-b95b-31147bd9f142`. Final candidate version `987b805f-1c41-4d30-a7c6-7092b4a0aa24`; broad-pilot candidate `dbe6446b-8e04-41fe-a9d6-5c317676bc5d`. Both use the identical 1M generation `e873d554d343bc48e65ca1ac7845d854f7ac6405b0f367eec65e37e3dd452a56`, Porter2 analysis, bundled directory/router, metadata generation and `aws:us-east-1` placement. No corpus/index uploads or builds were performed. Full identities, source digests, cache state, request IDs, native CPU/wall and counters are in [the artifacts](results/columnar/io-iteration-1m/summary.json) and [provenance](results/columnar/io-iteration-1m/provenance.json).

Freeze control source from `3129497` into `work/io-iteration/control` before running the local comparison. With existing local data, run:

```sh
CWS_LABEL=io-repeat CWS_PAIR_INDEX=work/columnar-complete-pairs-1m CWS_PLANS=control-N100-M1000,auto-N100-M1000 CWS_CONTROL_SOURCE=work/io-iteration/control CWS_CONTROL_RUNTIME=frozen CWS_CONDITION=fresh-namespace CWS_REPEATS=3 CWS_R2_MS=50 CWS_SHARED_MS=8 CWS_R2_JITTER_MS=30 CWS_ISOLATE_SCENARIOS=1 yarn node --import tsx bench/columnar/simulate.ts work/columnar-worker-stem-1m bench/results/columnar/io-iteration-1m/local-contract.json
```

Repeat with `CWS_CONDITION=shared-warm-memory-empty`. `io-iteration-contract.ts` generates expanded references from frozen local source; `io-live.ts` runs the live interleaved/load comparison with `with-tail.ts`. The existing deploy command supports preparing the same generation with `--membership work/columnar-complete-pairs-1m --metadata work/columnar-metadata-1m --prepare-only`; ensure identical placement before deploying an isolated benchmark. No comparison deployment changes the serving Worker. Recompute summaries with `yarn node --import tsx bench/columnar/summarize-io-iteration.ts`.

The account-wide usage snapshot reported no resource-limit errors or construction invocations; other account/bucket activity is included and analytics lag. It is not attributable billing or native peak memory evidence. Temporary benchmark resources are retired after measurement; the serving Worker and R2 generations are retained.
