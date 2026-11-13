# Local 1M: packet copies, CPU regressions and score lookahead

This round compares against untouched `d2e6c7c`. Everything is local on the same
1M generation used in `WARM-CPU.md`. The corpus, stemming/tokenization, format,
builder, bundled directories, pairs/context, sorted lists, scoring precision,
field semantics and excerpt code are unchanged. No Cloudflare work occurred.

## Changes

Grouped score reads previously concatenated all their pages and returned
subarrays of that large copy. They now retain independently owned pages until
all requested block views are made. A block inside one page uses a direct view;
only a crossing block gets an exact-sized copy. Transfer coalescing, checksums,
page ownership, bounded caches and request-local deduplication remain. This also
avoids retaining a multi-megabyte joined buffer through one small block view.
The new `packetCopyBytes` counter counts actual packet-slicing copies and
`packetViewBytes` counts bytes delivered without copying; the frozen control
has neither counter, so zero is not substituted for its missing values.

Cell bounds now visit the cells each block overlaps rather than rescanning every
block for every cell. Body and title maxima remain independent before weighting.
The clipped final cell excludes blocks outside the document window. The same
cell-to-block filter serves execution and lookahead.

Score lookahead now supports broad positional/negative expressions without a
selective document/membership mask and with positive scoring terms. It never
loads or decodes positions as a side effect. Pure negative positional queries
retain their previous path. Metadata is obtained for at most eight numeric
bands (131,072 document IDs): one bounded hierarchical walk per term for a
contiguous window, with separate bounded walks for gaps. This does not create a
whole-corpus flat plan. Numeric scoring bands remain 16,384 documents.

Before prefetching, the verified heap threshold and conservative per-cell bounds
remove blocks already unable to compete. Essential/eager transfer selection uses
the existing estimates; actual execution still obtains all missing data for its
survivors. Speculation does not prune matches or raise the threshold. Exact
matching, original float64 score summation, ties, pagination and exact-total
behavior remain in execution. Only verified matches enter the heap.

Prefetch is capped at the smaller of 4 MiB and one third of the application page
cache, compared with the prior 2 MiB cap. Application pages remain 12 MiB in the
harness, decoded cache 4 MiB, simulated shared cache 1 GiB per version. The larger
window retains more bounded metadata and speculative pages; it does not enlarge
those caches or the bundle. Source transfer buffers/page views still consume
transient memory. Local buffer counters are not native Worker peak-memory or
concurrency evidence.

## Iterations and validation

The copy-only pilot consistently lowered burden CPU; rules remained near flat.
A coarse-predicate specialization trial did not improve rules and was removed.
The final combination also avoids repeated metadata walks and prefetches only
surviving score cells. Four-band lookahead reduced mixed-negative score I/O
phases from 43 to 16; eight bands reduced them to 8 under the same transfer cap.
The four-band and other pilots are archived separately from final comparisons.

The independent exhaustive fixture now has 131,073 documents, crossing the
lookahead window and its partial tail. It exercises Boolean and phrase negation,
false positional leaders, fields, noninteger boosts, score-zero ties, exact
totals and search-after. A separate test covers page-boundary blocks, concurrent
grouped reads, checksum failure, tiny-cache eviction and retained byte ownership.
The full 160-contract 1M source-oracle replay passed, as did 248 tests in 66 files.

## Reproduction

Prepare the existing local generation/mirror; these commands do not download it.
The archived contracts are the previous 21-query workload, unchanged.

```sh
yarn node --import tsx bench/columnar/freeze-cpu-control.ts d2e6c7c
CWS_CONTROL_SOURCE=work/cpu-control-d2e6c7c CWS_CONTROL_RUNTIME=frozen CWS_CAMPAIGN=score-io-final-1m CWS_REPEATS=3 CWS_SESSIONS=2 yarn node --import tsx bench/columnar/planner-campaign.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/warm-cpu-contract-1m.json
yarn node --import tsx bench/columnar/report-maxscore.ts score-io-final-1m bench/results/columnar/score-io-1m work/cpu-control-d2e6c7c/control.json
CWS_CONTROL_SOURCE=work/cpu-control-d2e6c7c CWS_REPEATS=30 CWS_CPU_LABEL=final-s1 yarn node --import tsx bench/columnar/compare-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/warm-cpu-contract-1m.json work/score-final-cpu
CWS_CONTROL_SOURCE=work/cpu-control-d2e6c7c CWS_REPEATS=30 CWS_SEED=20269032 CWS_CPU_LABEL=final-s2 yarn node --import tsx bench/columnar/compare-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/warm-cpu-contract-1m.json work/score-final-cpu
yarn node --import tsx bench/columnar/report-cpu.ts work/score-final-cpu bench/results/columnar/score-io-1m
```

Two independently seeded sessions interleave versions and queries. Both use
independent bounded caches and complete response serialization without response
caching. Conditions are application reuse, empty application caches with warm
shared pages, and fresh application/shared namespaces. Bundled roots stay
resident: these are not new-isolate measurements. The storage model is unchanged:
origin 20 ms + 100 MiB/s, shared 2 ms + 1,000 MiB/s. Filesystem caches are
uncontrolled. No opaque R2 cache behavior is claimed.

CPU confirmation uses two independent process pairs, 30 responses per version
and query per session, after five warmups. Each child measures total batch CPU,
including its own GC, deferred cache work and IPC, divided by requests. This
avoids attributing one version's background GC to the other on a shared heap.
These are local process CPU measurements, not native Worker CPU. CPU source
identities now also include storage and bound code, not just search/kernels.

## Confirmed CPU results

Isolated batch CPU means in ms, 60 responses/version/query across two process
pairs, control → replacement:

| Query                               |             CPU |
| ----------------------------------- | --------------: |
| `(rules OR of) AND rule`            |   57.14 → 48.50 |
| `"burden of proving"` (body)        |   62.22 → 53.15 |
| `summary judgment` conjunction      |   27.14 → 22.53 |
| `(of OR the) AND limit`             |   64.06 → 57.17 |
| Broad common OR                     | 192.53 → 157.44 |
| Mixed negative Boolean              |   92.63 → 95.22 |
| `court NOT "personal jurisdiction"` |   56.68 → 64.14 |
| `"in the absence of"`               | 204.57 → 200.69 |

Rules improves 15.1%, burden 14.6%. Rules session means are 54.21–60.06 →
47.57–49.43 ms; burden 62.22–62.23 → 51.66–54.63 ms. These remove the measured
increases in the previous round, with current CPU near the earlier `3572902`
observations; cross-round absolute times are not a controlled comparison.

There are CPU tradeoffs: mixed negative +2.8% and personal-jurisdiction negation
+13.2%. Mixed session means are 92.52–92.73 → 93.35–97.09 ms; personal-jurisdiction
54.70–58.66 → 63.77–64.50 ms. The lookahead does more local planning and cached
score-read scheduling in exchange for fewer remote dependencies. These are
reported as regressions, despite the latency benefit. Session ranges are
small descriptive samples, not confidence intervals.

## Complete-response latency and work

Medians in ms, control → replacement. Each cell contains six measured responses
per version (three repetitions in each of two randomized sessions). Warm shared
means empty application caches; fresh means empty application and shared
namespaces. These timings include matching, ranking, metadata, snippets and JSON
serialization under the simulated storage model, not client HTTP latency.

| Query                          | Application reuse | Warm shared | Fresh namespaces | Score I/O phases |
| ------------------------------ | ----------------: | ----------: | ---------------: | ---------------: |
| Rules Boolean                  |          137 → 98 |   135 → 102 |      1,199 → 625 |           28 → 8 |
| Burden phrase                  |         278 → 209 |   288 → 210 |    2,909 → 1,774 |          50 → 10 |
| Mixed negative Boolean         |         301 → 231 |   296 → 231 |    2,526 → 1,562 |           43 → 8 |
| Personal-jurisdiction negation |         277 → 190 |   286 → 190 |    2,780 → 1,562 |           52 → 8 |
| Absence phrase                 |       976 → 1,017 | 972 → 1,030 |    6,152 → 6,004 |          61 → 61 |

The mixed query is `(jurisdiction OR "summary judgment") AND NOT "res ipsa loquitur"`.
The phases column counts score fetch calls that actually require shared/origin
I/O, rather than all logical packet calls or all query I/O dependencies. Logical
cached calls can increase: mixed score calls go from 83 to 131. All phase and
block figures here are medians; complete per-condition counters are archived.

| Query                          | Score blocks requested | Score postings decoded | Position integers decoded |
| ------------------------------ | ---------------------: | ---------------------: | ------------------------: |
| Rules Boolean                  |          6,055 → 3,027 |      226,304 → 226,304 |                     0 → 0 |
| Burden phrase                  |          2,622 → 3,205 |      171,904 → 171,904 |           25,375 → 25,375 |
| Mixed negative Boolean         |          7,211 → 7,348 |      903,600 → 903,600 |             5,880 → 5,880 |
| Personal-jurisdiction negation |          2,125 → 3,576 |      198,400 → 198,400 |             1,437 → 1,437 |
| Absence phrase                 |        21,222 → 21,222 |  1,428,234 → 1,428,234 |         108,078 → 108,078 |

Blocks requested include speculation and repeated logical requests, not unique
physical blocks. Decoded postings and position integers are unchanged for every
query in every final cache condition. Burden and personal-jurisdiction fetch
more speculative blocks to remove dependencies, without decoding extra postings.
Shared-warm mixed total storage bytes remain 36.00 MB; burden rises from 50.40 to
51.50 MB. Rules falls from 24.96 to 22.87 MB. These include result retrieval;
physical reads/bytes also depend on cache history. The new mixed packet-slicing
copy counter is 134,296 bytes, rules 31,904, burden 27,600. Control has no matching
counter. Raw results distinguish origin/shared/memory requests and bytes, all
fetch stages, CPU, decoded bytes and repeated decoding.

All 756 final responses passed the source oracle and exact cross-version response
hash checks. The separate CPU confirmations contain 960 measured responses, also
with exact hash agreement. Raw sessions, contracts, source identities, profiles,
pilots and validation logs live in `results/columnar/score-io-1m/`.

Six samples per latency cell cannot establish tail percentiles or reliable
confidence intervals. Rules application-reuse interquartile ranges are 132–138 →
98–100 ms, burden 276–290 → 199–216, mixed 285–312 → 225–237. Absence is especially
variable: 683–2,189 → 667–2,127 ms. Its median regresses 4.2% with application
reuse and 6.0% with warm shared pages, while fresh namespaces improve 2.4%; this
is not convincing evidence of a uniform regression or improvement. Keep the
cache conditions and workload classes separate.

Other median latency increases above 2% are `court` with title boost zero
(warm shared 33.2 → 34.9 ms; fresh 290.2 → 314.0 ms),
`qualified AND immunity NOT prison` (warm shared 94.6 → 102.2 ms), and
`NOT "summary judgment"` (fresh 229.8 → 236.8 ms). The packet-plan query has no
score phases and no changed execution path beyond shared storage slicing; these
small samples do not establish causality. The single-term case prefetches more
blocks before its heap becomes competitive. Keep these as regression cases.

## Remaining costs and next recommendation

The large common-term queries still exceed the bounded prefetch footprint, so
absence and broad common OR remain at 61 score I/O phases. They pay some window
planning overhead without the intended transfer consolidation. Personal-
jurisdiction negation and mixed Boolean CPU also increase despite their latency
wins. Speculative requests and cached packet scheduling are the next CPU targets.

Next, choose the lookahead span from estimated physical footprint before walking
all eight bands: use a shorter span when eight will exceed the cap, and avoid
revisiting resident score packets. Measure this against the present version,
including absence and personal-jurisdiction CPU. Do not simply enlarge the cache
or transfer cap: the current improvement already spends extra speculative bytes
and transient metadata to save dependency stages. Format, context and excerpts
need no changes for this next experiment.
