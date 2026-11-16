# Cold search execution, 1M court cases

## Clean live comparison

The completed interleaved run used 200 queries × three repetitions × two
Workers, with no overlapping search experiments. All 1,200 complete responses
succeeded and preserved ranked IDs/order, metadata and snippets (scores within
1e-10 relative tolerance). Independent validation passed all 76 oracle queries.
Application caches reset inside each request; every request used a unique shared
cache namespace. Exact totals and response caching were off.

| Metric                  | Frozen control | Replacement |
| ----------------------- | -------------: | ----------: |
| Client P50              |       1,359 ms |    1,252 ms |
| Client P95              |       4,317 ms |    3,463 ms |
| Client P99              |       7,262 ms |    4,816 ms |
| Worker CPU P50          |         308 ms |      292 ms |
| Worker CPU P95          |       1,451 ms |    1,319 ms |
| Worker CPU P99          |       2,179 ms |    1,741 ms |
| Errors                  |        0 / 600 |     0 / 600 |
| Native CPU observations |      600 / 600 |   600 / 600 |

The control is version `c926c8cd-47ae-496a-af72-7f6887e4787b`; the replacement
is `e04c2574-e9ec-4e73-8a02-079f6ac62e1a` (commit 130c739). Later candidate
seeking, correlated-anchor replanning, compound phrase scoring and generic
complete-list reads are **not** in this live table.

Scenario-block bootstrap 95% intervals remain broad: control P99 5,572–8,769 ms,
replacement P99 3,918–7,020 ms. These are 600-request workload samples, not
production traffic percentiles or final P99 estimates. Workload classes and
per-query regressions remain separate in `final-200-report.json.gz`; raw results
are `final-200.json.gz` under `bench/results/columnar/cold-routing-1m/`.

The largest remaining replacement medians were the common-phrase conjunction
(5,258 ms), fraud-on-the-court Boolean query (4,256 ms), newly-discovered-evidence
conjunction (3,730 ms), and stay-discovery Boolean query (3,583 ms). Some slower
individual queries had identical reads/bytes and nearly identical native CPU;
three samples cannot establish those differences as engine regressions.

## Cheap term evidence inside Boolean branches

The planner can now combine small complete term lists with pair candidates in
the initial parallel read wave. For example, `nonparty OR intervenor` supplies
a conservative filter for the fraud-on-the-court query. Unknown OR sides prevent
that filter; negative clauses never subtract approximate evidence. Phrases may
supply a necessary word, but adjacency and exact Boolean verification still
follow. The final sorted intersection feeds the existing continuation selector.

This optional path is considered only against block execution with more than
128 forecast pair candidates. It excludes common/proved words, caps individual
DF at 50,000, total frequency bytes at 1 MiB, and estimated decoded arrays at
4 MiB. Estimated avoided work must exceed bytes, decoding and request-wave
cost before any term I/O begins. These are scheduling budgets, not recall limits.

Five-repetition local 1M pilot results against commit 907b6f4:

| Query                                                       | Simulated median, before → after | Local CPU median |      GETs |       Transfer |
| ----------------------------------------------------------- | -------------------------------: | ---------------: | --------: | -------------: |
| Fraud on the court / nonparty or intervenor                 |                   1,483 → 963 ms |     927 → 274 ms | 203 → 149 |  50.4 → 7.2 MB |
| Qualified immunity / First Amendment / retaliation variants |                   1,710 → 677 ms |     505 → 340 ms |  304 → 51 | 7.36 → 7.34 MB |

The other three pilot queries performed no new filter reads and retained their
work counters. Their timing variability, alongside the background suffix build,
precludes attributing small CPU/latency movements. All results matched; the full
suite passed 97 files / 348 tests, including the existing damaged-preparation
test and a new verified-range coverage test. Evidence is in
`boolean-term-filter-local.json.gz`; full 200-query local and live comparisons
are kept separately.

## Further candidate execution changes

### Later cold regression checks

The complete 200-query term-filter comparison (two requests per query per
version, simulated I/O) preserved all results. P50/P95/P99 changed from
244/922/1,422 ms to 254/851/1,452 ms. This exposed two substantial regressions:
smaller candidate sets led optional pair-context refinement to open hundreds of
tiny chunks before the complete phrase executor read the same logical list.
The refinement now compares its GETs, transfer and decoding estimate with a
complete pair read before starting I/O. The representation and context stay
unchanged.

Complete-frequency execution also accepts conjunctions of exact phrases and
ordinary terms. It checks each remaining required term's frequency in the
requested field before admitting a scored match. Words already proved by a
mandatory phrase need no additional presence counter. Boolean alternatives,
negatives and proximity expressions retain their existing executors.

Five repetitions of ten selected queries against f469ec9, with empty application
and shared caches and simulated I/O, all preserved results. Examples:

| Query                                                             | Simulated median, before → after | GETs, before → after |
| ----------------------------------------------------------------- | -------------------------------: | -------------------: |
| Counterclaim / amended complaint / Rule 15 or responsive pleading |                   1,457 → 586 ms |             294 → 71 |
| Reconsideration / summary judgment / new arguments                |                   1,400 → 711 ms |             251 → 66 |
| Newly discovered evidence AND diligence                           |                     919 → 641 ms |             159 → 51 |
| To the extent that AND jurisdiction                               |                     723 → 464 ms |              93 → 52 |

The first eight-query pilot supplied the medians above; the subsequent
ten-query pilot also includes the positional-wait cost correction. Raw results
are `context-choice-local.json.gz` and `position-cost-local.json.gz`.
The diligence change transfers 10.2 MB instead of 4.9 MB. The jurisdiction
change decodes 2.81M document IDs instead of 1.72M, but reduces score I/O phases
from eight to one. These trades require live validation; reduced GET counts are
not sufficient proof of a latency improvement. The full suite passes 350 tests
in 97 files, including exact ranks, fields, metadata filters, totals, cursors and
snippets.

A separate live 12-query pilot compared 130c739 with f469ec9, five requests per
query per version. All 120 responses agreed. The user's summary-judgment /
arbitration / third-party-beneficiary query improved from a median 3,116 to
2,306 ms; fraud-on-the-court improved from 4,682 to 2,423 ms. The common-phrase
conjunction regressed from 3,181 to 3,776 ms, with median CPU 1,565 to 2,271 ms;
the negative abuse-of-discretion query also regressed, with identical work
counters. Individual samples vary substantially, including native CPU. These
regressions remain unresolved rather than being attributed to network noise.
See `boolean-filter-pilot{,-cpu,-report}.json.gz` for every sample.

For the arbitration query, forcing both continuations on identical candidates
locally measured 679 ms for postings versus 618 ms for document verification
(seven repetitions). Document verification used 139 GETs / 4.26 MB versus
82 GETs / 24.79 MB. The automatic cost estimate omitted positional fetch phases
after scoring. It now includes candidate bands with uncovered, nonresident
positions; proved or already resident positions add no estimated phase.
These are scheduling estimates, never matching or ranking bounds.

Sorted membership cursors now use their existing restart tables to seek past
unneeded blocks, including through nested unions and intersections. Compound
pair evidence retains its final sorted intersection when it fits within
256 KiB; larger sets keep streaming. Intermediate branches calculate cardinality
only when requested, rather than counting every branch before intersection.

When a unigram document forecast proves too optimistic, the executor now prices
pair evidence again against the actual anchor intersection before falling back
to blocks. Newly filtered IDs feed directly into document or block execution.
This introduces one optional discovery wave; it does not truncate candidates.

Local 1M comparisons used empty application/shared caches, simulated 20 ms origin
latency and 100 MiB/s per-read bandwidth, six shared request slots, exact totals
off, and complete responses. These are diagnostic measurements, not live claims:

| Query                                              | Repetitions per version | Simulated median, before → after | Local CPU median |      GETs |      Transfer |
| -------------------------------------------------- | ----------------------: | -------------------------------: | ---------------: | --------: | ------------: |
| Requests for admission                             |                       7 |                 1,173 → 1,103 ms |     382 → 264 ms | 224 → 224 |     unchanged |
| Section 1407 remand / pretrial proceedings         |                       5 |                     934 → 400 ms |     347 → 144 ms |  102 → 57 | 34.5 → 3.9 MB |
| Small Business Administration / sovereign immunity |                       5 |                     639 → 545 ms |     275 → 153 ms |  66 → 106 | 13.9 → 5.3 MB |

Admission membership decoding fell from 907,750 to 167,903 integers; repeated
decoded membership bytes fell from 3,287,336 to 327,948. The remand anchor had
152 actual candidates despite a forecast of nine; pair evidence reduced it to
24 before verification. The SBA case reduced 815 candidates to 77, but its
increased GET count requires live evaluation. The unchanged broad controls in
the five-query replan pilot moved by about −4% to +3% in simulated latency.

The separate 20-query check preserved every ranked ID, score within tolerance,
metadata and a query-relevant snippet. Its CPU/latency observations overlap
local tests and the suffix build and should not be used to claim small timing
differences. The full suite passed 96 files / 345 tests, including exhaustive
matching, fields, repeated terms, ties, cursors and randomized mixed seek/next
operations. Machine-readable evidence is in `membership-reuse-local.json.gz`,
`membership-bottom20-local.json.gz`, and `correlated-anchors-local.json.gz` under
`bench/results/columnar/cold-routing-1m/`.

The suffix comparison now freezes the current ordinary engine when it starts,
so subsequent generic query improvements cannot be credited to the suffix
index. Its local comparison driver also supports selected queries and records
source hashes for uncommitted experiments.

## Complete lists after matching

Complete-frequency execution also covers conjunctions made entirely of exact
phrase streams. It scores the original distinct words, including overlap
between phrases, and uses the existing positional evaluator for snippet spans.
The compound budget is 20 MiB of frequencies, 24 MiB estimated page footprint,
8 MiB cumulative context, 262,144 candidate upper bound, and at most 24 MiB
for frequency bytes plus candidate/score arrays. Context remains streamed and
released before score retrieval. No phrase-score addition is used.

In a five-repetition local 1M pilot, `"under the circumstances" AND "in light of"`
changed from 1,317 to 727 ms simulated median, 904 to 744 ms local CPU, 116 to
65 GETs, and 29.2 to 24.3 MB. Four other queries retained their original plans;
their simulated medians ranged from −20% on a 65 ms query to +5%. These small
samples establish an experiment to validate live, not population percentiles.
Fields, nested conjunctions, repeated phrases, overlapping words, exact totals,
metadata filters and cursors match the exhaustive small-corpus engine, including
full snippets.

Ordinary complete-term and unigram-anchor reads now use directly addressed
extents too. A request retains complete packets so later block access can reuse
their subranges. The complete-term planner retains its existing transfer and
decoded-memory budgets. Decoders avoid copying an already owned full packet;
page-backed subarrays still copy to prevent retaining uncharged backing pages.
Ten selective queries, five repetitions each, preserved results and reduced
transfer on nine; packet assembly copies disappeared on all three queries that
had them. Simulated medians were essentially unchanged (−2% to +3%). For example,
the remand query fell from 3.88 to 3.10 MB with the same 57 GETs and about 363 ms.
Native latency and cache fragmentation still require evaluation.

Evidence: `conjunction-frequency-local.json.gz` and
`complete-terms-direct-local.json.gz` in the same results directory. The full
suite passed 96 files / 345 tests; the added local-range and complete-packet
tests also passed. The local range source can assemble an unfamiliar coalesced
extent from already-verified local coverage; uncovered ranges still fail
instead of making network requests inside a timed run. Assembly counts and
harness hashes are recorded separately.

The planner now prices optional pair context before reading it, avoids pairs whose
context is already proved, and executes routed complete phrase descriptors the
same way as bundled descriptors. Planning reads numeric document sizes without
creating result keys, and reuses validation of packed directory columns.

Short exact phrases can finish matching first, then read complete frequency
packets concurrently. Only document IDs are unpacked for candidate-overlapping
score blocks; frequencies and field lengths are accessed directly for verified
matches. Scoring still uses the original distinct-word BM25 contributions,
float64 arithmetic, fields, title boosts, ties and cursors. Presentation uses the
existing code. No index-format, context or excerpt changes are required.

Complete-list reads use stable extent cache identities and avoid splitting a
list into pages and assembling it again. Sparse block execution still uses
256 KiB pages. The initial eligibility budgets are 16 MiB of frequencies,
20 MiB of estimated physical footprint, 4 MiB of pair context and 131,072
possible matching documents. These select an executor; they never truncate
matches. Larger queries retain block execution. The cost comparison also
considers estimated score-block coverage and fetch phases.

## Live measurements

Corpus: 1,000,000 court cases, 2,503,094 normalized terms, 44,815,427 pairs,
complete previous/next occurrence context. Machine-readable results record the
corpus generation, Worker versions, options and request/isolate identifiers.

Every measured request resets application caches in that request and uses a
fresh shared-cache namespace. Exact totals and response caching are off;
metadata and snippets are included. Requests originate in New England/BOS.
These conditions do not create a fresh isolate or control opaque R2 caches.

The first interleaved 200-query comparison used three repetitions per query per
engine:

| Client latency      | Frozen control | Planner/CPU changes |
| ------------------- | -------------: | ------------------: |
| P50                 |       1,366 ms |            1,184 ms |
| P95                 |       4,369 ms |            3,135 ms |
| P99                 |       7,328 ms |            4,485 ms |
| Successful requests |        600/600 |             596/600 |

All successful responses agreed on ranked IDs/order, display fields and snippets;
scores use a relative tolerance of 1e-10. The candidate had three empty 500s and
one admission rejection. Additional phrase experiments overlapped part of this
run and placed extra load on the candidate. Treat this as exploratory evidence,
not a clean load comparison. CPU observations cover 600 control and 355 candidate
responses. A separate, nonoverlapping comparison follows the cancellation fix.

The final phrase pilot compares complete frequency reads with the preceding
block executor. Five cold requests per query per engine, randomized/interleaved:

| Phrase                        | Client median, blocks → complete | CPU median, blocks → complete | R2 GETs |
| ----------------------------- | -------------------------------: | ----------------------------: | ------: |
| newly discovered evidence     |                 1,247 → 1,037 ms |                  357 → 268 ms | 39 → 28 |
| leave to amend                |                 1,458 → 1,417 ms |                  520 → 405 ms | 56 → 36 |
| third party beneficiary       |                   1,402 → 944 ms |                  337 → 216 ms | 39 → 27 |
| in the absence of             |                 2,177 → 1,465 ms |                  901 → 720 ms | 83 → 47 |
| clear and convincing evidence |                 2,246 → 1,256 ms |                  962 → 472 ms | 63 → 36 |
| burden of proving             |                 1,740 → 1,107 ms |                  575 → 423 ms | 52 → 34 |

The block control had one capacity rejection in this pilot; medians exclude
failed responses and the failure remains in the raw results. No candidate
failures or result differences occurred. Five requests are insufficient for
tail estimates. The complete scorer reduces score I/O phases from 7–8 to one.
Its larger number of decoded document IDs does not imply decoding every row's
frequency columns or calculating every row's BM25 score.

## Reliability and rejected experiments

Dictionary decompression previously shared a semaphore across requests. A native
workerd regression test demonstrates that an abandoned lookup leaves later
requests returning “hung and would never generate a response.” Request-local
scheduling fixes the reproduction while retaining the shared validated-data
cache. This establishes a real failure mode consistent with the live symptoms;
the empty live 500s did not contain enough information to prove their cause.

An earlier complete-frequency implementation decoded all five numeric columns
in overlapping blocks. It raised CPU and regressed burden in its first live
pilot. Direct frequency access for matching rows removed that cost. A separate
attempt to append pair positions without temporary result arrays had inconsistent
CPU results and was removed.

Validation includes the 76-query independent live oracle, exhaustive small-corpus
comparisons, metadata filters, field boosts, repeated terms, zero-hit phrases,
ties, pagination, totals and snippets. The 200-query comparison supplements
rather than replaces that oracle. Results and intermediate experiments are under
`bench/results/columnar/cold-routing-1m/`; `compare-cold.ts`, `compare-report.ts`
and `profile-cold.ts` reproduce the measurement procedures.

### Complete cold comparison after candidate score ordering

The nonoverlapping repeat compares `43e7b4c` against `21ff91a` on the same 200
queries, three randomized repetitions per engine. All 1,200 requests succeeded;
ranked document IDs/order, display fields and snippets agreed. Native CPU samples
were joined for all 600 requests per engine. The independent 76-query live
oracle also passed. This comparison has no suffix index enabled.

| Metric           |      Control P50/P95/P99 |  Candidate P50/P95/P99 |
| ---------------- | -----------------------: | ---------------------: |
| Client latency   | 1,105 / 3,140 / 4,343 ms | 976 / 2,567 / 3,111 ms |
| Worker CPU       |   253 / 1,170 / 1,646 ms |   209 / 950 / 1,499 ms |
| Worker wall time |   756 / 2,462 / 3,752 ms | 658 / 2,042 / 2,445 ms |

The candidate scores a bounded conservative document set before scheduling
expensive verification. Only verified matches raise the competitive threshold.
It stops starting document reads when exact scores prove the remaining
candidates cannot enter the heap, preserving cursor and tie ordering. Exact
totals and unsupported conditions retain the exhaustive path. This is a query
execution change; the corpus format, context and excerpt code are unchanged.

For requests for admission, client median fell from 2,966 to 2,489 ms and CPU
from 789 to 556 ms. Verification packages fell from 170 to 26 and total GETs
from 224 to 100. The cost is more transfer: 10.03 to 27.87 MB, including 20.65 MB
of complete frequency packets retained while scoring. Across the entire set,
P99 transfer increased from 20.59 to 24.27 MB. Candidate buffer sizes and cache
retention are reported separately; they are not measurements of isolate peak
memory or cumulative allocations.

Six hundred requests per engine remain insufficient for production tail
estimates. Resampling whole scenarios gives approximate 95% intervals of
3,651–4,537 ms for control P99 and 2,810–3,660 ms for candidate P99. These are
workload statistics from BOS, not production traffic percentiles. The earlier
sparse integer-decoding experiment was reverted because its local CPU results
did not establish a native improvement.

Raw responses, native observations, joined report and independent validation
are `ranked-documents-cold-200{,-cpu,-report}.json.gz` and
`ranked-documents-validation.json` in the results directory above. Worker
versions, code, generations, request IDs, cache namespaces and options are in
those artifacts. Concurrent memory/admission tests and 10M readiness remain
unestablished. The suffix experiment is separate.
