# Phrase planning and batched score lookahead on 1M documents

This is a **local, simulated-I/O** comparison against `4850a4a1699ec93728b25c76ed69bb463e455ac3`.
Both engines use the same retained 1,000,000-document index with complete context
for every observed pair. No index rebuild, format change, context change,
presentation change, upload, deployment or Cloudflare measurement was performed.
N=100/M=1000 and sorted membership lists remain unchanged.

## Cold results across all 200 queries

**Exact totals are off for all 200 queries.** Three observations per engine/query,
**1,200 complete responses**, all correct. This supersedes the earlier mixed
193-off/7-on comparison; none of its timings are pooled into these results.

| Percentile | Control, query medians | New, query medians | Change |
| ---------- | ---------------------: | -----------------: | -----: |
| P50        |               385.8 ms |           382.4 ms |  −0.9% |
| P95        |             1,509.6 ms |         1,299.9 ms | −13.9% |
| P99        |             2,095.0 ms |         1,952.6 ms |  −6.8% |

Across the 600 measured requests per engine, pooled empirical P50/P95/P99 are
**387.8/1,533.1/2,127.0 → 387.2/1,316.7/2,038.7 ms**. Neither set of
percentiles represents production traffic. The scenario-median table removes
some single-observation noise but three observations still do not establish
precise per-query distributions or reliable production P99 estimates.

129 query medians improve and 71 worsen. Requiring both 10% and 10 ms gives
**25 material wins and zero material regressions**. This threshold is descriptive,
not a significance test. The overall median is essentially unchanged; the
improvement is concentrated in slower queries.

| Workload class             | Queries | Control P50/P95/P99, ms | New P50/P95/P99, ms |
| -------------------------- | ------: | ----------------------: | ------------------: |
| Rewritten research queries |     180 |     349 / 1,510 / 2,153 | 342 / 1,309 / 2,137 |
| Unfamiliar queries         |      20 |     615 / 1,447 / 1,781 |   533 / 962 / 1,021 |

Largest absolute improvements, abbreviated here; the
[complete CSV](results/columnar/phrase-planner-1m/wide-empty.csv) and
[JSON with observed ranges](results/columnar/phrase-planner-1m/wide-empty.json)
include every query and regression:

| Query                                                              | Cold median, ms | Score fetch waves |  Origin MiB |
| ------------------------------------------------------------------ | --------------: | ----------------: | ----------: |
| Under the circumstances AND in light of                            |     1,781 → 814 |            44 → 8 | 24.4 → 24.4 |
| To the extent that AND jurisdiction                                |     1,447 → 668 |            36 → 8 | 17.5 → 17.5 |
| Stay discovery / motion to dismiss / good cause                    |   2,153 → 1,587 |            25 → 7 | 40.8 → 40.8 |
| Protective order / confidential financial / burden of proof        |     1,223 → 682 |            27 → 8 | 15.5 → 15.5 |
| Civil contempt / ambiguous / specific and definite                 |     1,073 → 589 |            27 → 8 | 12.6 → 12.6 |
| Abuse of discretion AND NOT criminal history/sentencing guidelines |     1,165 → 679 |            26 → 8 | 13.3 → 13.3 |

The mechanism is fewer dependent stages and better request grouping, rather
than fewer scored postings. For the first row, score postings decoded remain
769,231 and origin reads fall 118 → 93. Some logical score-block prefetch
counts increase: lookahead can request blocks before a later competitive
threshold would have rejected them. These examples transfer the same physical
bytes and decode the same score postings; logical prefetch counts are not unique
origin-block transfers.

Remaining slowdowns include Rule 6(b)/excusable neglect/late opposition,
**1,368 → 1,423 ms (+4.0%)**, and fair use/market dilution,
**949 → 1,002 ms (+5.7%)**.
These are real observed slowdowns below the chosen materiality threshold;
unchanged work counters alone do not prove they are measurement noise.

## Secondary cache conditions and correctness

| Workload / cache condition                | Responses | Control P50/P95/P99, ms | New P50/P95/P99, ms |
| ----------------------------------------- | --------: | ----------------------: | ------------------: |
| 29 focused cases, empty                   |       174 |     639 / 2,104 / 2,127 | 567 / 1,653 / 1,985 |
| 29 focused cases, shared warm / app empty |       174 |         114 / 311 / 596 |     107 / 265 / 545 |
| 29 focused cases, application reuse       |       174 |          82 / 294 / 602 |      74 / 267 / 533 |
| 200 queries, shared warm / app empty      |       400 |          46 / 198 / 286 |      46 / 175 / 299 |

These are percentiles of query/options medians. Focused runs use three
observations per engine/case and retain seven exact-total cases for regression
coverage. Both 200-query runs have every exact total off. The wide shared-warm
check has only one observation per engine/query: it shows a material regression
for `"to the extent that" AND jurisdiction`, **277 → 402 ms**, despite its cold
improvement **1,447 → 668 ms**. This remains unresolved; one observation does not
establish its repeatability. The three focused cache comparisons have no
regressions above the stated 10% and 10 ms threshold.

Across these runs, the main cold run and the separate 160-query oracle there
are **2,282 measured correct responses**, excluding priming and profiling.
Ordered IDs, metadata, snippets and applicable totals agree; oracle score
comparison uses relative tolerance 1e-11. The full suite passes **310 tests in
84 files**, including exhaustive small-corpus Boolean/proximity cases, fields,
shared-word position guards, ties, pagination and exact totals. Typechecking,
formatting of changed files and `git diff --check` pass.

## Remaining cold bottlenecks

The slowest query is still fraud-on-the-court/nonparty/intervenor/appeal at
**2,176 ms**, with 49 positional waves, 261 reads and 64.7 MiB. Statute of
limitations/fraudulent concealment/motion to dismiss takes **2,137 ms**, with
41 positional waves, 286 reads and 70.7 MiB. Score batching does not remove
these serial positional reads or their physical amplification.

Candidate-document execution also remains expensive: intervention-as-of-right
takes **1,953 ms and 462 reads**; requests-for-admission takes **1,931 ms and
452 reads**. Their winner presentation accounts for approximately 0.18 and
0.17 MiB respectively, so excerpt optimization is not the priority.

All 20 slowest cold queries have separate CPU/allocation profiles and tagged
cold I/O traces. [The tail report](PHRASE-TAIL-1M.md) lists every query and
separates the 15 positional-I/O cases from the five document-verification cases.
Fraud and limitations transfer 47.5 and 53.7 MiB for ordinary word positions;
intervention and admission issue 428 and 407 verification reads for 5.8 and
9.5 MiB. These establish different byte/wave and request-count problems.

The next recommendation is a cold-focused comparison of bounded positional
lookahead/coalescing on filtered blocks, followed by request grouping for compact
document verification. Measure additional bytes as well as stages, retain active
data until consumption, and keep comparing against complete-context execution.
This is a useful tail improvement, not grounds to declare the 1M engine fast
enough or ready for 10M adoption.

## Changes

- Retain cheap complete-term and candidate-document continuations after actual
  filtering. Do not replace them with a global pair scan. Exact phrase pricing
  compares the phrase's own word data, rather than charging the whole query's
  data to each phrase's alternative.
- Retain exact evidence across up to eight 16,384-document windows. This permits
  the existing bounded score lookahead to group requests across phrase windows.
  Empty candidate windows avoid score-tree discovery. Evidence is released after
  scoring; lookahead stops at 4 MiB of evidence, with an indivisible window still
  subject to the existing per-document positional limits. Encoded stream prefetch
  remains at most six 256 KiB ranges per positional source.
- Two-word Boolean phrases may execute authoritative field-aware membership
  lists, without scanning every pair occurrence. Positional use, including a
  repeated occurrence of the phrase elsewhere under proximity, retains real
  positions. Membership never supplies an invented span.
- Compare membership discovery and its downstream positional reads against
  complete context before optional hot-pair discovery I/O. Small context streams
  remain positional. Unknown pairs still use the existing parallel discovery
  wave. These are cost estimates, not bounds used to discard candidates.
- Skip ordinary positional blocks for a membership-proven absent phrase when no
  other phrase or explicit term needs those words' positions. The evaluator knows
  that an absent phrase has no spans. Matching phrases still use the existing
  positions and presentation algorithms. Tests cover shared-word uses so a guard
  cannot hide another branch's required positions.

Constituent-word BM25 scoring, field boosts, float64 precision, deterministic
ties, exact totals, negative branches and search-after remain unchanged. Only
verified matches update the competitive threshold.

## Measurement

The frozen control includes its own executor, Reader, caches, directories and
local object reader. The harness now loads its bundled `exact-phrases.bin` too;
omitting that file would compare against the wrong architecture. Profiling uses
the same directory repair. Source digests are checked before/after each run.

Cold complete-response latency is the primary selection criterion. The finalist
workload contains 29 focused query/options cases with three repetitions per
engine under each cache condition. The wider set contains the 180 rewritten
research queries plus 20 unfamiliar queries: three repetitions per engine empty
and one shared-warm secondary check. All 200 have exact totals off; the 29-case
focused regression set separately retains seven exact-total cases. A separate 160-query oracle runs
on the candidate. Comparisons randomize/interleave engines using seed 20261113.
Each query/engine/repetition has independent caches and untimed priming when warm.

The model is 20 ms + 100 MiB/s R2, 2 ms + 1,000 MiB/s shared cache, six active
requests, 256 MiB shared cache, 12 MiB application page cache, 4 MiB decoded cache
and a 900-operation shared-cache budget. Shared-warm uses three priming passes
then clears application memory in request; application reuse uses one priming
pass. An empty namespace does not simulate a new isolate or control backend R2
caches. No response caching is used. Complete response timing includes metadata,
query-relevant snippets and JSON serialization.

Per-query samples are small: report medians and observed ranges, not confidence
intervals or production request-tail estimates. Wider-set percentiles describe
the distribution of query medians. CPU is local process CPU; no Worker CPU claim
is made. Raw observations, manifests, per-query CSV/JSON and CPU/allocation
profiles are in [the evidence directory](results/columnar/phrase-planner-1m).

## Rejected experiments and limits

Unconditionally preferring membership regressed small phrase streams, including
Rule 11 and IDEA/bad faith: it substituted serial ordinary-word position reads
for cheap complete context. Full continuation pricing retains positional execution
for those cases.

The CPU-favoring membership variant was also rejected for mixed-negative
jurisdiction/summary-judgment. It improved warm CPU but the cold pilot regressed
from approximately 765 to 1,068 ms. The final cost model charges the existing
winner-position executor's serial windows instead of pretending those reads form
one six-request parallel wave. The final plan retains complete pair context for
this query. Warm CPU savings from that rejected variant are not final results.

Deferring all winner spans to a separate pass at the end of each window increased
repeated positional fetches when other uncovered phrases had already used those
blocks. That experiment was removed. The presentation algorithm is unchanged.

Buffer counters estimate active numeric/evidence storage, not native heap peak or
retained memory. The candidate's general active-buffer counter additionally
accounts for retained phrase evidence, so its accounting is broader than the
control's. Compare the dedicated phrase-buffer counter separately. Allocation
sampling is cumulative and must not be interpreted as simultaneously resident
memory.

## Reproduce

With the retained complete-context index available locally:

```sh
yarn node --import tsx bench/columnar/run-phrase-planner.ts

yarn node --import tsx bench/columnar/report-phrase-planner.ts wide-empty
yarn node --import tsx bench/columnar/report-phrase-tail.ts select

CWS_PROFILE_SOURCE=. CWS_LOCAL_DATA=work/complete-context-v2-1m \
CWS_PROFILE_ALL=1 CWS_PROFILE_CONDITION=fresh-namespace CWS_TRACE_IO=1 \
yarn node --import tsx bench/columnar/profile-warm-cpu.ts \
  work/complete-context-v2-1m work/complete-context-v2-1m \
  work/phrase-planner-tail-contract.json work/phrase-planner-tail-profiles

yarn node --import tsx bench/columnar/report-phrase-tail.ts report

yarn test
yarn run check
yarn node --import tsx bench/columnar/report-phrase-planner.ts
```

Run measurements without concurrent construction, profiling or tests. The runner
reconstructs the separate control from Git and decompresses the saved contracts;
it performs no remote preparation. `CWS_RUN_FILTER` selects one measurement group.
