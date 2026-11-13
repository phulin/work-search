# Lazy batched MAXSCORE on the local 1M corpus

This round changes numeric score-window execution in `src/columnar/search.ts`.
The corpus, analysis, ranking formula, float64 score contributions, binary
format, N=100/M=1,000, sorted lists, pair/context data and excerpt code are
unchanged. All experiments use local bytes with simulated storage delays. There
are no deployments, uploads, live Cloudflare calls or bitmap indexes.

## Execution

A numeric batch covers 16,384 documents. Posting blocks remain 128 postings and
physical pages remain 256 KiB. A larger numeric workspace amortizes dependent
reads; it does not change the index or result/passage locators.

Within a surviving batch:

1. Select an essential candidate generator. A selective mandatory word is
   sufficient independently of rank. Otherwise, MAXSCORE defers a low-bound
   prefix of positive terms only while its outward-rounded sum remains strictly
   below the verified competitive threshold. A matching document outside the
   essential union cannot reach that threshold, even if a Boolean branch
   matches without a positive term. No such rank argument is used at a zero or
   unfilled threshold.
2. Read/decode essential score blocks first. Unloaded terms have unknown
   presence in the full three-valued Boolean predicate; they are never treated
   as absent. Candidate IDs stay in document order in reused numeric buffers.
3. For each candidate, sum exact loaded contributions and conservative
   per-128-document-cell bounds for unloaded contributions. Round the bound
   outward without subtracting previously used bounds. Reject only when it
   cannot enter top-K, respecting document-ID tie order.
4. Select deferred blocks by interval overlap with the remaining sorted IDs.
   Fetch their union in one coalesced parallel read phase, not per document.
   Blocks are decoded directly into `ScoreBatch` arrays with original block
   indices retained for positional and result locators.
5. Evaluate complete field/Boolean presence and sum all exact contributions in
   the original query-term order. Then perform the existing phrase/proximity
   verification. **Only verified, pagination-eligible matches enter the heap.**
   Partial candidates never raise the threshold.

Exact-total queries retain exhaustive eager score execution and exact positional
verification. An unfilled heap does not justify score pruning; selective
mandatory-word rejection remains valid. Negative positional expressions stay
unknown until verified. Existing search-after eligibility and deterministic
score/document ordering are preserved.

## Eager fallback and prefetch

Lazy numeric decoding does not require serializing every transfer. The planner
estimates occupied posting blocks from essential posting counts and document
spans. It defers nonessential transfers when those pages are resident or at
least 64 KiB of avoided work is predicted. Otherwise it fetches all scoring data
in one wave, decodes essential columns first, and decodes deferred columns only
for survivors. This is an estimate selecting work, never a pruning bound or a
candidate limit. A dense distribution can still make an extra phase unhelpful.

The same decision controls four-batch lookahead prefetch. Eager fetch decisions
can retain coalesced lookahead; lazy ones prefetch essentials only. Prefetch keeps
the existing 2 MiB physical-footprint cap. Score reads use the Reader's existing
range coalescing, six-slot scheduling, generation-scoped caches and validation.
Extra transferred bytes remain visible in the I/O counters.

The 16K batch workspace increases per-query numeric memory relative to the old
4K batch. The existing parser limit of 16 distinct terms bounds `ScoreBatch`
arrays below 9.4 MiB (previously below 2.4 MiB); no new query limit is added.
`ScoreBatch.bytes` and peak-active-buffer diagnostics include the arrays. No
larger cache or bundled-data budget is introduced. Native peak/retained memory
under concurrent Worker requests is outside this local-only experiment.

## Measured iterations

The first 4K-batch implementation reduced decoded work but serialized too many
reads. On a two-repeat warm pilot, broad OR score I/O waves rose from 98 to 191;
latency rose from 472 to 772 ms despite score postings falling from 2.83M to
2.25M. It is not retained as a separate production implementation.

Increasing numeric batches to 16K and coalescing score reads brought the same
pilot class to 76 score I/O waves and about 408 ms. Sparse conjunctions still
showed extra waves because lookahead prefetched essentials even when the actual
fetch decision was eager. The final implementation uses the same fetch decision
in both places. Pilot results are diagnostic; the repeated final runs below
are the comparison to use.

## Control, workload and measurement

The frozen pre-change control is commit `b322b8b`. Its source is extracted into a
separate ignored directory. Counter-only annotations route its original
`many()`/`prefetch()` calls through symmetric score instrumentation; they preserve
fetch/decode order and execution. The control does not receive the new numeric
batch size, selection, coalescing or pruning logic. Original/instrumented search
hashes are recorded in `control-instrumentation.json`.

Reproduce after preparing the existing local 1M serving mirror:

```sh
yarn node --import tsx bench/columnar/freeze-maxscore-control.ts
CWS_CONTROL_SOURCE=work/maxscore-control-b322b8b CWS_CAMPAIGN=maxscore-final-1m CWS_REPEATS=3 CWS_SESSIONS=2 yarn node --import tsx bench/columnar/planner-campaign.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/maxscore-contract-1m.json
yarn node --import tsx bench/columnar/report-maxscore.ts maxscore-final-1m bench/results/columnar/maxscore-1m
```

The archived 18-contract workload draws from existing independent source
references: broad OR, nested OR/conjunctions, ordinary conjunctions, positive and
negative phrases, phrase pagination, zero-score title ties, a sparse zero-hit
phrase, and the burden/absence regression cases. Each timed response checks IDs,
ranking, scores, metadata and relevant snippets against its independent oracle.
The whole 160-contract replay separately covers more fields, boosts, negation,
Unicode, repeated terms, proximity and pagination.

Two independent randomized/interleaved sessions compare independent per-version
application caches and bounded 1 GiB simulated shared caches. Conditions are
normal application reuse, empty application caches with warmed/evolving shared
pages, and empty application caches with a fresh shared namespace per request.
Bundled roots stay resident; these are not new-isolate/startup measurements.
Warm caches can evict. Host filesystem caches are uncontrolled. The model uses
20 ms + 100 MiB/s for origin and 2 ms + 1,000 MiB/s for shared reads; response
caching is off. Latency includes matching, ranking, metadata, snippets and JSON
serialization. CPU is local process CPU, not native Worker CPU.

Score metrics count numeric-window execution and its lookahead, excluding
alternative complete-term/document-package execution and pre-window selective
anchor reads. Unique score blocks fetched include requested prefetch blocks;
coalescing may also transfer neighboring bytes. Decoded blocks/postings count
actual work, including repeats. Score fetch waves count nonempty score read or
prefetch calls. Score I/O waves count those calls that perform shared-cache or
origin operations. These are sequential score phases, not all query I/O stages
or individual GET counts. Raw results retain total reads/bytes, positions,
metadata costs and overall work counters as well.

## Final results and validation

All 648 timed responses passed correctness, with zero errors, unsupported plans
or network downloads. Each query/version/cache condition has six observations
across two sessions. Complete-response medians in ms, control → replacement:

| Query/class                       | Application reuse | Empty app / warm shared | Empty app / fresh shared |
| --------------------------------- | ----------------: | ----------------------: | -----------------------: |
| `court OR the OR of OR "and"`     |         466 → 379 |               471 → 370 |            3,596 → 2,535 |
| `summary OR judgment`             |          111 → 75 |                111 → 75 |              1,107 → 701 |
| `summary judgment` (conjunction)  |          117 → 80 |                118 → 80 |              1,183 → 692 |
| `(fiduciary OR duty) AND court`   |         272 → 168 |               272 → 169 |            2,032 → 1,105 |
| `"clear and convincing evidence"` |         500 → 341 |               501 → 350 |            4,854 → 3,416 |
| `"burden of proving"` (body)      |         360 → 284 |               367 → 294 |            3,841 → 2,919 |
| `"in the absence of"`             |       1,323 → 984 |             1,232 → 883 |           10,030 → 6,070 |
| `"stating that defendant"`        |         925 → 599 |               948 → 627 |            8,471 → 5,208 |
| `"the and of the"`                |         470 → 371 |               467 → 373 |            5,328 → 3,933 |
| `(of OR the) AND limit`           |         203 → 202 |               217 → 199 |            1,885 → 1,877 |

The summary retains all 18 contracts and quartiles/ranges for every metric. No
final per-contract/cache median latency regressed, but tiny differences are not
established improvements. These are small descriptive samples, not useful
P95/P99 estimates or production traffic percentiles. For example, fresh-cache
broad OR has IQR 3,497–3,642 → 2,524–2,548 ms; absence has IQR
9,946–10,101 → 6,066–6,122 ms. Those large latency differences persist across
sessions. There is no weighted aggregate.

Numeric-window work under application reuse, control → replacement:

| Query/class                    | Unique score blocks requested | Score postings decoded | Score I/O waves | Process CPU ms |
| ------------------------------ | ----------------------------: | ---------------------: | --------------: | -------------: |
| Broad common OR                |               25,565 → 21,591 |  2,825,544 → 2,208,422 |         98 → 61 |      293 → 311 |
| Summary conjunction            |                 2,727 → 4,254 |       145,408 → 68,096 |         34 → 15 |        52 → 71 |
| Fiduciary/duty conjunction     |                 7,942 → 7,647 |      999,552 → 155,776 |         57 → 22 |      191 → 117 |
| Clear/convincing phrase        |                 5,857 → 5,843 |      782,464 → 256,640 |         91 → 58 |      280 → 255 |
| Absence phrase                 |               21,216 → 21,222 |  2,833,723 → 1,428,234 |        152 → 61 |      652 → 564 |
| Mixed OR with negative phrases |                 7,375 → 7,211 |    1,128,650 → 903,600 |         62 → 43 |      209 → 313 |

The mixed negative query is
`(jurisdiction OR "summary judgment") AND NOT "res ipsa loquitur"`. Decoded
counts include repeated boundary blocks. Clear/convincing decoded blocks fall
from 6,113 to 2,005 despite similar unique blocks requested; fetch and decoding
are deliberately independent. Lazy transfer decisions and eager-fetch fallback
counts are separately available in the summary. Broad dense queries usually
keep eager transfer and prune decoding; sparse/cached continuations can defer
both. The latency gains combine batching, coalescing and partial-score pruning;
they cannot be attributed to pruning alone.

### Regressions and remaining costs

- **CPU is mixed.** Warm mixed-negative CPU rises 209 → 313 ms; summary
  conjunction rises 52 → 71 ms, and broad OR rises 293 → 311 ms. Fresh-cache CPU
  is different: broad OR falls 2,004 → 1,900 ms, absence 4,418 → 3,482 ms, and the
  mixed-negative query 1,327 → 1,269 ms. Node process CPU includes runtime/GC
  work; this does not establish a native CPU improvement. The partial-predicate
  loops, larger workspaces and coalesced-buffer copies need local profiling.
- **More requested blocks can still win latency.** Summary conjunction requests
  2,727 → 4,254 unique blocks because eager lookahead is retained, while decoding
  less than half as many postings. Fresh origin bytes rise 13.53 → 13.86 MiB,
  but origin GETs fall 69 → 52 and score I/O waves 34 → 15. Summary OR similarly
  rises 12.45 → 14.03 MiB despite fewer GETs. These are real read-amplification
  regressions, not hidden decoder savings.
- **Bootstrap and memory grow.** The zero-score title-tie case requests
  234 → 442 score blocks and decodes 19,584 → 30,080 postings before the heap
  becomes competitive. Its latency is approximately flat, but CPU rises
  14 → 38 ms warm. Broad OR peak-active-buffer diagnostics grow 0.93 → 3.60 MiB;
  absence grows 1.59 → 4.36 MiB. These are active-buffer diagnostics, not whole
  process/native peak memory measurements.
- **Broad phrases remain expensive.** Fresh-cache absence still needs 787
  origin GETs and 193.46 MiB, versus 791 GETs and 190.96 MiB before. Fewer score
  dependencies improve latency substantially; total transfer barely improves
  and bytes actually increase. Excerpt work remains unchanged.

The final source passed `yarn run check`, all 246 tests across 66 files, and all
160 local 1M correctness contracts with artificial latency disabled. The new
independent exhaustive tests cover lazy Boolean/phrase execution, high-scoring
positional nonmatches, exact score bits versus exhaustive eager execution,
fields, zero-score ties, totals and pagination. The source fingerprint is
identical across that replay and all six timed runs. Formatting and diff checks
also pass.

Raw runs, the workload, frozen-control instrumentation provenance, failed pilot
measurements, correctness replay, validation logs and machine-readable summaries
are in [results/columnar/maxscore-1m](results/columnar/maxscore-1m).

The next local experiment should profile the warm CPU regressions and test
avoiding coalesced-buffer copies while retaining grouped I/O. Smaller bootstrap
batches may reduce the early-tie read amplification. Keep the index/context
format and excerpts fixed. Native adoption and concurrent memory headroom are
not established by these simulated measurements.
