# Complete pair context and independently executable phrases on 1M documents

Every observed adjacent pair now retains its occurrence positions and the previous
and next normalized token, separately by field. Coverage has no frequency-rank or
storage-budget cutoff. The old top-2,000-only external build was rejected and was
never deployed. The bundle's 2,000 hot descriptors are metadata only; all other
pairs are directly discoverable through routed membership packets.

The frozen control is `c53eb32`. Complete coverage and routed execution are in
`7276931`; `d3dfe06` avoids score reads for authoritatively empty phrase fields.
Both engines search the retained 1,000,000-document corpus and unchanged base
scoring/document generation. Sorted integer lists remain in use, with no bitmaps.
The [design](../docs/EXACT-PHRASES.md) describes the format and execution.

## Coverage, construction and storage

| Coverage                         |          Pairs |       Occurrences |
| -------------------------------- | -------------: | ----------------: |
| Existing complete inline context |     44,529,289 |       235,417,244 |
| New complete external context    |        465,896 |     1,262,097,867 |
| **All observed pairs**           | **44,995,185** | **1,497,515,111** |

External context occupies **14,905,267,963 bytes in 889 immutable objects**.
The complete router occupies **4,600,808 bytes**, and bundled hot descriptors
occupy **223,662 bytes**. Routed records carry either complete inline context or
extents for their complete external stream; there is no bundled per-pair address
table for the long tail. The rewritten membership containers occupy additional
storage alongside the unchanged base index. No document presentation bytes or
excerpt algorithms changed.

Construction read 35,940,362,664 occurrence-source bytes and completed in
**468.46 seconds (7m48s)** using four local processes. Counted scatter fills a
bounded numeric partition buffer, avoiding millions of intermediate files. The
largest such buffer was 468,664,288 bytes. This is a measured 1M build, not a
10M estimate.

An independent finished-index validation completed in 79.45 seconds. It visited
all 44,995,185 routed records and all 889 external objects, checking framing,
generation identity, every position/previous/next column span, and each pair's
per-field document and occurrence counts. It does not expand every stored integer
value; independent exhaustive query tests establish matching semantics. Coverage
and validation receipts are included with the machine-readable evidence.

## Execution and measurement contract

A covering pair can establish a two-, three- or four-token phrase, including its
positions for nested proximity. Four tokens require the middle pair. A complete
phrase stream participates in Boolean candidate filtering **before** score-block
retrieval. Negative unknowns remain conservative, and longer phrases retain exact
verification. Ranking continues to use constituent-word frequencies and the
original BM25 formula, field boosts, float64 precision and deterministic ties.

For `"in the absence of"`, the phrase-matching evidence comes solely from
`the absence`: **160,277 occurrences, 1,895,689 bytes, eight bounded ranges and
zero ordinary-word positional reads**. No other pair membership or common-word
presence list is required for this standalone phrase. Exact totals remain
81,353 documents for the ordinary phrase, five for body-only
`"under the absence of"`, and 14 for `"above the absence of"`.

Complete coverage also makes previously omitted anchors available. The planner
now selects `of proving` for `"burden of proving"`: 50,221 occurrences and
618,028 bytes, compared with the limited build's 213,979-occurrence `burden of`
source. For `"failure to exhaust"`, `to exhaust` has 18,557 occurrences and
204,839 bytes. These are corpus-selected execution choices, not query-specific
index additions.

The finalist comparison randomizes and interleaves control/candidate with seed
20261113 and N=100/M=1000. Fourteen query/options combinations have three
repetitions per engine under each of three cache conditions (252 measured
responses). A wider 200-query set has two repetitions per engine (800 responses),
and a separate 160-query oracle checks the candidate. Total: **1,212 measured
responses**, plus unmeasured priming. Complete responses include ranked IDs,
scores, metadata and query-relevant snippets. Harmless numerical FP error is
allowed; ranked IDs/order, display data, exact totals and pagination must agree.

Simulation uses 20 ms + 100 MiB/s origin reads, 2 ms + 1,000 MiB/s shared reads,
six active requests, 256 MiB shared cache, 12 MiB application page cache, 4 MiB
decoded cache and a 900-operation shared-cache budget. Conditions distinguish
empty namespaces, bounded shared-page priming with in-request application reset,
and application reuse. “Shared warm” can still incur origin reads through cache
capacity or the operation budget. No response caching is used. These are local
simulations, not native Worker latency or production traffic percentiles.

## Local results

Complete-response simulated medians in milliseconds, **control → complete
context**, three observations per cell. These small samples diagnose mechanisms;
per-cell observed ranges and all individual observations remain in the artifacts.

| Query / options                                 |   Empty caches | Shared warm, app empty |     App reuse |
| ----------------------------------------------- | -------------: | ---------------------: | ------------: |
| `"in the absence of"`, top 20                   |  3,566 → 1,560 |              475 → 268 |     944 → 258 |
| Same, exact total                               | 14,567 → 1,654 |            4,189 → 303 |   8,320 → 304 |
| `"under the absence of"`, body, exact total     |   11,269 → 431 |            1,892 → 108 |    5,783 → 84 |
| `"above the absence of"`, exact total           |    5,269 → 647 |              824 → 132 |    2,553 → 86 |
| `"burden of proving"`, body                     |    1,445 → 882 |              158 → 113 |      143 → 47 |
| Arbitration + two phrases, exact total          |      655 → 660 |                81 → 79 |       26 → 24 |
| Admission + Boolean phrase branches             |  2,045 → 2,040 |              226 → 228 |     248 → 252 |
| Mixed negative: jurisdiction / summary judgment |    1,018 → 777 |          **138 → 243** | **108 → 192** |

Arbitration and admission retain the existing selective document continuation;
forcing global streams there was an unsuccessful experiment. Their traffic is
essentially unchanged apart from slightly larger routed descriptors.

For absence with exact totals, cold origin reads fall **879 → 90**, and origin
bytes **232.3 → 18.5 MB**. Ordinary-word positional waves fall **429 → 0**.
Scoring barely changes: **2,840,891 → 2,839,995 postings decoded**, and score
waves increase **33 → 39**. This separates the matching improvement from the
remaining score-layout/scheduling cost.

The five-hit body phrase shows candidate rejection before scoring: score blocks
fall **19,794 → 35**, score postings **2,563,874 → 4,480**, and cold origin bytes
**200.2 → 8.5 MB**. Its ordinary-word positional waves fall **330 → 0**.
The 14-hit variant decodes 10,752 score postings instead of 1,990,307.

Local process-CPU medians (diagnostic, not Worker CPU):

| Query / options                  | Empty caches, ms | Shared warm, ms |
| -------------------------------- | ---------------: | --------------: |
| Absence, exact total             |      5,783 → 620 |     2,602 → 301 |
| Under absence, body, exact total |      4,463 → 244 |      1,459 → 85 |
| Burden, body                     |        566 → 287 |     **50 → 56** |
| Mixed negative                   |    **409 → 500** |    **97 → 254** |

The burden latency improvement does not imply an established warm CPU win.
CPU samples contain GC/cache bookkeeping and are noisier than these numerical
medians suggest. Native attribution is recorded separately below.

The first complete-coverage comparison exposed an empty title-field regression:
the executor knew the pair had zero title occurrences but still decoded a body
anchor before applying that knowledge. `d3dfe06` prevents that I/O, with a test
whose source throws on any unnecessary read. No matches or scoring are skipped
without authoritative proof.

The mixed-negative query `(jurisdiction OR "summary judgment") AND NOT
"res ipsa loquitur"` remains a warm CPU regression in the final comparison:
a broad exact pair stream can do more verification than the existing late
positional checks, and it reduces score lookahead. Complete coverage does not
make every global phrase scan profitable. This is a planner limitation, not a
reason to omit context from storage.

The wider 200-query set has **zero correctness failures** across 800 measured
responses. Across the 200 per-query latency medians, P50/P95/P99 are
**53.9/208.4/332.9 ms → 56.9/212.3/297.2 ms**. These describe this equally
represented scenario set, not traffic. 110 query medians decrease and 90 increase;
requiring both a 10% and 10 ms difference yields 11 wins and 11 regressions.
There is no overall median or P95 improvement to claim.

| Wider query, abbreviated                                | Shared-warm median, control → new |
| ------------------------------------------------------- | --------------------------------: |
| `"under the circumstances" AND "in light of"`           |                    2,605 → 602 ms |
| `"court order" W/P ("collateral attack" OR forfeiture)` |                      290 → 171 ms |
| `"failure to exhaust" AND (administrative OR remedies)` |                      200 → 148 ms |
| `"stay discovery" AND "motion to dismiss" AND …`        |                  **197 → 266 ms** |
| `"leave to amend" AND futility AND …`                   |                  **143 → 200 ms** |
| `"Rule 16" AND "good cause" AND …`                      |                  **143 → 190 ms** |
| `"Rule 26(f)" AND (defer OR stay) AND …`                |                  **169 → 212 ms** |

Rule 11 also shows 47 → 114 ms, but its two new observations are 44 and 185 ms,
versus 46 and 47 ms for the control. Both engines used the same 51-document
continuation, read counts and decoded position count. The single outlier does
not establish a structural execution regression. The other listed regressions
appear in both observations and warrant planner/scheduling work. Two observations
per engine do not support useful confidence intervals or request-tail estimates.
The [full CSV](results/columnar/exact-phrases-1m/queries-200.csv) and
[JSON with ranges](results/columnar/exact-phrases-1m/queries-200.json) expose every
query rather than only the favorable cases.

## Native attribution and memory

Local native workerd profiling used the complete `7276931` engine and index,
with four representative phrase queries and a concurrent pair of requests.
Startup observed 3,247,672 bytes of used heap and 27,591,256 bytes of backing
storage. The largest sampled concurrent observation was 30,335,204 bytes used
heap plus 67,613,317 backing bytes (**97,948,521 combined**). These are snapshots,
not guaranteed native peaks. Forced GC was unavailable, so they do not establish
retained memory. Allocation sampling is separate from those observations. Across two profiled
allocation calls per query it estimates 353.0 MB allocated for absence,
235.3 MB for under-absence, 126.0 MB for burden and 127.8 MB for failure-to-exhaust.
Those cumulative sampled allocations are not simultaneously resident memory.

Each active phrase prefetches at most six 256 KiB ranges and retains only its
current 16,384-document window's exact positions. Active-buffer accounting is an
estimate, not native heap measurement. Tests exercise split long rows and a
zero-hit stream larger than the former 4 MiB cumulative-transfer cutoff.

## Validation and remaining work

The final complete build passed **309 tests across 84 files**, including native
workerd checks and the additional empty-field test. Typechecking and formatting
checks pass; final checks are recorded with the evidence. The independent exhaustive tests include repeated terms,
fields, Boolean negatives, nested proximity, score ties, exact totals, snippets
and search-after.

Broad matching can now be cheap while scoring remains expensive. Broad
exact-total phrases still decode many constituent-word score postings; sparse
matches can touch large score-page footprints. The next experiment should price
stable sparse frequency reads or compact candidate scoring against those physical
pages. Warm mixed-negative planning needs a separate correction before promotion.

This establishes complete context on the retained 1M corpus. It does not establish
10M behavior, production P99, or full-corpus readiness. Existing deployed controls
remain separate from this generation.

## Deployment status

The full local context generation is built, validated and retained. Publication
began to the benchmark bucket, then was stopped with a resumable receipt after
the 200-query results were requested. **No new Worker was deployed or promoted.**
A partial immutable generation in R2 is not a serving-ready complete index.
The existing 1M benchmark control remains unchanged. The current measurements
above are simulations and local native attribution; there is no new live latency
claim. Given the broad-set regressions, planner correction should precede
promotion and the next live comparison.
