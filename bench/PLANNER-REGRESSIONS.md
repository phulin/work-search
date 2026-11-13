# Local 1M planner regressions

This round keeps N=100/M=1,000, the original complete pair generation, 128 KiB
packet target, 8 KiB context rule, and sorted membership lists. No index rebuild,
upload, deployment or live Cloudflare request is part of this experiment. The
existing source corpus and local serving mirror remain in place. Excerpt and
snippet construction are unchanged.

## Decisions before reads

Planning now has an explicit local phase followed by one parallel initial read
wave. It first obtains bundled term metadata and chooses the ordinary unigram,
complete-term or block plan. Pure functions decide which pair packets and common
presence lists, if any, can repay their work relative to that alternative. The
selected packet requests, necessary cold term metadata and selected presence
requests then start together. There is no serial pair-dictionary discovery.

Pair cost uses actual packet addresses/sizes from the bundled router, known
field DFs, a prior derived from the tail of the corpus-ranked bundled pair table,
and mandatory-word DFs. Unknown pair counts remain estimates; they never prove
absence or reject documents. Two ordinary pair intersections are evaluated
before either read. An excluded common pair can filter an already worthwhile
ordinary anchor. Shared-word conditioning moderates the intersection estimate.
The estimates do not truncate candidates.

The initial block-work model estimates occupied 128-document cells, encoded score
bytes and positional verification work. Ranked verification starts with a 1/128
fraction prior; exact-total execution uses full verification work. A 1 MiB work
premium accounts for an extra fetch phase, in addition to packet and membership
decoding bytes. These are explicit local planning priors, not calibrated native
latency predictions or pruning bounds. Cheap complete-term plans retain priority
instead of speculatively reading optional filters. Candidate-package alternatives
use document counts and package bytes. The model's remaining errors are measured
below rather than hidden by query-specific rules.

Common-word filters are evaluated against the selected candidate plan, not the
unfiltered corpus. A selected pair already proves presence of both its words;
those words cannot trigger redundant presence reads. The presence cost includes
packet bytes, estimated visited restart blocks and an incremental-read premium.
Broad filters that barely affect score cells are omitted. Every excluded word
still contributes to exact matching and BM25 scoring.

After reads, the ordinary packet planner compares available candidate packages
with its existing complete-term/unigram choice. Exact bundled package lengths
are checked before a transfer. A broad membership does not force block execution,
and a weaker pair anchor does not replace a cheaper unigram anchor. Loaded
memberships remain filters/evidence in the selected continuation, including a
budget fallback. Matching coverage is retained throughout.

Within selected ranges, sorted numeric cursors intersect pair lists without
repeated binary probes. Broad presence scans use sequential intersections;
sparse candidate sets keep restart-block probes. There are no bitmap encodings.
No scoring, Unicode analysis, positional semantics, tie order or cursor changes
are introduced. A bundled exact zero field count, or an authoritative absent
pair, may still prove a mandatory phrase impossible.

## Control and reproduction

The comparison uses the previous committed pair engine as its frozen control,
with the same N/M settings, corpus, packets and simulated storage model:

```sh
mkdir -p work/pair-control-2d77fc0
git archive 2d77fc0 src | tar -x -C work/pair-control-2d77fc0
CWS_REPEATS=5 CWS_SESSIONS=2 yarn node --import tsx bench/columnar/planner-campaign.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/pair-pilot-contract-1m.json
```

Twenty contracts include common natural phrases, sparse/mutated phrases, all-common
zero-hit phrases, body/title fields, OR, negation and an unquoted conjunction.
Eight have an independent exhaustive 1M token-scan reference; the others use the
existing source reference. Metadata and matching-phrase snippets are checked.
Each response includes matching, exact ranking, metadata, snippets and JSON
serialization. Response caching is disabled.

Two randomized sessions use different seeds and independent caches for each
version. Each has five interleaved repeats under normal application reuse,
reset application page/decoded/term caches with warm shared pages, and fresh
shared-cache namespaces with empty application caches. Bundled roots remain
resident. The model charges 20 ms plus 100 MiB/s for origin reads and 2 ms plus
1,000 MiB/s for shared reads. The shared cache is bounded at 1 GiB: the warm
conditions retain the evolving workload cache, not a guarantee that every
request hits. Evictions can still cause origin reads. Host filesystem caches
are not controlled. These
are Node diagnostics with modeled I/O, not live Worker or HTTP latency.

## Final results

All six runs completed: 1,200/1,200 correct timed responses, zero errors or
unsupported plans, and zero network downloads. There are ten samples per
query/version/cache condition across two independent randomized sessions.
Complete-response medians, control → replacement, in milliseconds:

| Query                           | Application reuse | Empty application / warm shared | Empty application / fresh shared |
| ------------------------------- | ----------------: | ------------------------------: | -------------------------------: |
| `"burden of proving"` (body)    |         422 → 380 |                       433 → 400 |                    4,010 → 3,948 |
| `"burden of proving"` (all)     |         470 → 460 |                       498 → 485 |                    4,550 → 4,582 |
| `"in the absence of"` (all)     |     1,294 → 1,134 |                   1,294 → 1,178 |                  10,575 → 10,333 |
| `"in the absence of"` (title)   |           16 → 10 |                         16 → 11 |                          47 → 12 |
| `"the an of"`                   |          573 → 18 |                        586 → 21 |                       6,719 → 82 |
| `"the and of the"`              |         496 → 477 |                       508 → 486 |                    5,520 → 5,507 |
| `"and absent a showing"`        |         644 → 617 |                       666 → 610 |                    6,689 → 6,283 |
| `"because of the pip"`          |         490 → 502 |                       496 → 511 |                    5,409 → 5,384 |
| `"on the other hand"`           |       749 → 1,075 |                     745 → 1,100 |                    6,509 → 9,501 |
| `"stating that defendant"`      |         779 → 934 |                       829 → 905 |                    7,759 → 8,751 |
| `"there is no evidence"`        |         745 → 873 |                       797 → 902 |                    7,324 → 8,358 |
| `"because level the pip"`       |           15 → 15 |                         16 → 17 |                          42 → 65 |
| `"circuit court curiam saydon"` |           13 → 16 |                         14 → 17 |                          43 → 67 |

These are descriptive local medians, not production percentiles or reliable
P95/P99 estimates. The machine-readable summary retains quartiles and ranges
for every metric and all 20 contracts. For example, fresh-cache body burden has
IQR 4,000–4,022 → 3,929–3,987 ms; the fresh-cache sparse phrase has IQR
6,710–6,737 → 81–86 ms. Fresh-cache other-hand regresses with disjoint IQRs,
6,435–6,552 → 9,458–9,555 ms. Small differences and mixed CPU results should not
be generalized beyond this workload/model. No weighted aggregate is used.

The CPU and decode counters explain why skipping optional work is not uniformly
better. Under application reuse, body-only burden drops pair-membership integer
decoding from 427,157 to zero, while ordinary position decoding rises from 15,981
to 25,375; process CPU falls from 241 to 226 ms. Absence retains 108,078 position
integers and drops from 940 to 780 ms CPU by avoiding presence filtering. The
control did not instrument common-presence integers: that metric is explicitly
null in the summary, rather than treating its missing counter as zero.

The sparse `"the an of"` intersection increases membership decoding from 646 to
1,558 integers but removes 157,757 ordinary position integers and reduces median
shared reads from 563 to four. CPU falls from 348 to 30 ms. The other pathological
phrase, `"the and of the"`, retains 223,075 ordinary position integers and doubles
membership decoding (177,960 → 368,916); its small wall-time improvement is not
evidence of a general decoding gain.

Fresh-cache origin reads and transferred MiB (median, control → replacement):

| Query                 | Origin reads |      Origin MiB |
| --------------------- | -----------: | --------------: |
| Body burden           |    212 → 211 |   48.08 → 47.85 |
| All-field burden      |    222 → 228 |   50.67 → 52.19 |
| All-field absence     |    793 → 791 | 191.87 → 190.96 |
| Title absence         |        2 → 0 |        0.91 → 0 |
| `"the an of"`         |      563 → 4 |   137.99 → 1.36 |
| `"on the other hand"` |    388 → 631 |  91.43 → 151.69 |

The broad target phrases still require hundreds of origin reads; their cold
latency improves little. Cold body burden's process CPU also rises from 1,245
to 1,375 ms, despite its warm CPU improvement. Cold absence's CPU falls from
4,458 to 3,934 ms. These are Node process measurements, not Worker CPU claims.

### Remaining regressions

`"on the other hand"` incorrectly loses a useful pair: ordinary position decoding
rises from 44,533 to 163,802 integers, CPU from 532 to 712 ms, and median shared
reads from 390 to 634. `"stating that defendant"` similarly rises from 264,424 to
661,918 position integers and 522 to 637 ms CPU. `"there is no evidence"` also
regresses. The uniform 1/128 competitive-verification prior understates the
work these pairs avoid. These are planning failures, not permission to restore
the unconditional post-read executor override.

`"because of the pip"` does more membership work with its extra intersection:
113,196 → 649,192 integers and 214 → 257 ms CPU, without reducing its 72,314
ordinary position integers. Its wall-time difference is small, but the extra
decoding is real. Sequential intersections should not always replace probes
when one list is much smaller. Context storage and excerpt work are unchanged.

Two short zero-hit queries expose dependent-stage regressions. For
`"because level the pip"`, the chosen pair intersection leaves two documents to
verify rather than proving zero immediately: diagnostic stages rise from one
to two, even though origin bytes fall from 0.91 to 0.21 MiB. For
`"circuit court curiam saydon"`, declining optional reads while term metadata is
cold loses an early pair rejection; stages rise from two to three while reads
fall from four to two and bytes from 0.73 to 0.13 MiB. Both cost about 24 ms more
with empty shared caches. Fewer reads/bytes alone is not sufficient.

### Validation and next step

The full repository suite passes: 244 tests across 65 files. Added independent
sorted-stream tests compare random intersections with Set-based references;
planner tests cover optional-read rejection, retained sparse common anchors,
proved-word filters, and refusing to force a broad membership over a complete
term or cheaper unigram plan. The existing exhaustive Boolean, positional,
field, tie, pagination and long-document checks also pass. `yarn run check`
passes. The broader independent 160-contract 1M replay also passes all responses,
with zero errors, unsupported plans or network downloads. Its artificial latency
is disabled: it is correctness evidence, not another performance sample.

Raw runs, contracts, configuration/corpus/format identifiers, source digests,
per-query CPU/decode/I/O counters and summaries are in
[results/columnar/planner-1m](results/columnar/planner-1m). Source stayed unchanged
throughout timing; final source formatting was followed by correctness checks.

Next, keep N/M and this format fixed and calibrate the cost of competitive
positional verification, pair context proof coverage, and dependent stages on
held-out phrase classes. Compare sequential intersections with restart probes
by list-size ratio. Those measurements should repair the rejected-useful-pair
and short cold-query regressions before changing storage or expanding the
corpus. The named warm regressions are reduced, but this planner is not yet
stable enough for full-corpus adoption. Router compaction was deferred.
