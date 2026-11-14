# Document verification redesign, 1M

The replacement separates candidate verification from result presentation. A
candidate now needs a compact document-local inverted index, rather than a full
forward token array and all compressed display text. The term-oriented index
remains available for broad queries. Membership remains sorted integer lists;
there are no bitmaps. The [format document](../docs/COLUMNAR-VERIFICATION.md)
describes the representation and execution paths.

This iteration also implements independently chunked pair positions/context.
The initial corpus-selected pool contains 93 pairs and 77.8 MB of context. None
of the 200 research/held-out queries selected those supplemental chunks under
the current cost policy. Their correctness is tested, but a latency benefit
from that selection pool has **not** been established. Expanding useful coverage
is still work to do.

## Construction and controls

The retained corpus has 1,000,000 documents, 2,539,780 normalized/stemmed terms,
and 354,667,130 term-document postings. Analysis is `nfkc-lower-porter2-v1`.
Corpus SHA-256 is
`2d1b9cf2d7f0d610875de8e8f309fdc93f41c00dd777991b59865028d1a8580a`.
The new generation is
`206e473362f2ed3ad8074a9840a6d03c5d9633605bc3365ee35d8eeebbf868f8`.

The local control is frozen source from `5d897ff`, before this redesign. Its
document records were reconstructed in the old CDP3 arrangement using exactly
the candidate's compressed passages. Thus local comparisons hold snippet
content and passage boundaries constant. It is separate benchmark data, not a
second production decoder. The deployed comparison control is older and must
be interpreted separately.

| Data                                                      |         Bytes |
| --------------------------------------------------------- | ------------: |
| Numeric document verification                             | 4,848,618,202 |
| Full new document containers, including presentation      | 8,603,727,765 |
| Frozen control document containers with the same passages | 9,183,136,207 |
| Term-oriented objects                                     | 6,089,055,260 |
| Pair membership objects, including updated packets        | 7,374,971,341 |
| Supplemental positional context                           |    77,779,216 |

The complete pair index represents 990,101,772 pair-document memberships;
44,529,289 pair records already carry inline context. Supplemental selection
currently considers the top 1,000 corpus pairs that lack inline context. That
limited pool is a limitation, not complete positional pair coverage.

Document conversion streamed source containers, retaining bounded caches and
one document's working arrays; it took about 21.5 minutes locally. Term
conversion used an on-disk directory and took about 27.6 minutes. Pair packet
conversion took about 18.7 minutes. These passes overlapped, so their times
cannot be added to obtain total elapsed construction time. This was a migration
of the retained corpus; the production document builder writes the new format
directly from corpus partitions.

## Decisions established by measurement

Positions use 32 KiB independently addressable chunks. A numeric record fitting
within 1 MiB is fetched completely on its first read; larger records retain
direct frequency and positional range reads. Every numeric record in this
corpus fits below that threshold; the largest is 606,182 bytes. Direct selected
range execution for larger records is covered by long-document tests, not by a
claim that these 1M measurements exercised it.

A 32 KiB complete-read threshold was rejected: dependent frequency/position
reads outweighed saved transfer for these documents. Raising it to 128 KiB
helped but still added many reads. At 1 MiB, candidate verification transfers
only numeric data and decodes only requested terms. Small winner display tails
are coalesced. Small winners first encountered during result retrieval can be
read completely in one range; rejected candidates cannot use that path.

Shrinking document records also exposed an anchor-cost error: pricing pairs
solely by bytes could reject filtering that saved many candidate fetch waves.
The planner now includes a conservative wave cost in that comparison. All
fallbacks retain complete candidate coverage and exact phrase verification.

## Local experiments

Comparisons randomize query and variant order and interleave frozen-control and
candidate execution. The simulation models R2 as 20 ms plus transfer at
100 MiB/s; shared pages as 2 ms plus 1,000 MiB/s. It permits six I/O slots,
256 MiB simulated shared storage, 12 MiB raw and 4 MiB decoded application
caches, and a 900-operation shared-cache budget per request. No response cache.
Complete matching, ranking, metadata, snippets and JSON serialization are timed.

Empty-cache tests use independent application/shared namespaces. Memory reuse
uses one untimed same-query prime. Shared-warm/application-empty tests use three
bounded priming passes and reset application memory in the measured request.
Priming passes retain the same 900-operation budget. This distinguishes an
application reset from a new isolate. It does not model or control opaque R2
backend caches.

There are five measurements per query/variant for empty and shared-warm
conditions and seven for memory reuse: 340 measured complete responses across
ten scenarios. An additional 200-query comparison includes the 180 rewritten
research queries plus 20 unfamiliar queries, two repetitions per side, for
800 measured responses. These samples diagnose workload classes; they do not
provide a production P99 estimate. Local process CPU includes Node/runtime
activity and is not native Worker CPU.

Medians below are simulated complete-response milliseconds, control → new.
Arbitration uses limit 20 with an exact total; the separate limit-7 scenario is
also present in the raw results. These are not live Worker measurements.

| Query                                                              |         Empty | Memory reuse | Shared warm, application empty | Empty origin MiB |
| ------------------------------------------------------------------ | ------------: | -----------: | -----------------------------: | ---------------: |
| Summary judgment + arbitration + third-party beneficiary           |   1,518 → 632 |     168 → 24 |                       167 → 79 |     23.45 → 3.93 |
| Requests for admission + phrase OR                                 | 1,911 → 2,018 |    222 → 254 |                      228 → 236 |    26.20 → 15.14 |
| Mandate rule + Boolean conditions                                  |       59 → 86 |        4 → 3 |                        10 → 13 |      0.56 → 0.52 |
| Statute of limitations + affirmative defense + Rule 16 + diligence |     215 → 373 |      39 → 32 |                        47 → 60 |      2.67 → 1.57 |
| Burden of proving                                                  | 1,453 → 1,428 |    138 → 138 |                      152 → 150 |    24.31 → 24.28 |
| In the absence of                                                  | 3,477 → 3,460 |    934 → 894 |                      460 → 478 |  124.81 → 124.78 |
| (rules OR of) AND rule                                             |     448 → 462 |      20 → 20 |                        54 → 56 |      6.85 → 6.84 |

Arbitration now chooses candidate documents rather than scattered score blocks.
Admission's numeric verification reads fall from about 21.7 MB of old packages
to 9.9 MB, and forward scanning of 836,898 token integers becomes direct decoding
of 67,173 requested position integers. However, rejected-candidate savings do
not remove winner display reads: retained verified winners still need that
additional phase. The cold statute and mandate regressions are important
examples. This format is not a universal latency improvement.

Across 400 measurements per implementation on the 200-query workload, local
complete-response P50/P95/P99 were approximately 24/86/131 ms for the control
and 12/78/133 ms for the new engine. These equally weighted diagnostic workload
quantiles have only two observations per query; the apparent tail difference
does not establish a traffic P99 change. Larger regressions include res judicata
with privity/same-transaction (54 → 84 ms) and reconsideration with summary
judgment/new arguments (46 → 73 ms).

Warm Node allocation sampling over three executions estimates arbitration at
162 → 80 MB (limit 20) and 146 → 60 MB (limit 7); both request exact totals.
Admission instead increases 269 → 327 MB. Its largest allocation sites remain
branch/candidate layout, with new per-document frequency-block allocations also
visible. These are sampled cumulative allocations, including collected objects.
Node RSS/backing memory also includes the simulated shared cache and is not
evidence of a Worker memory-limit violation or of native retained memory.

The actual bundled Worker also completed a local workerd profile over arbitration,
admission, the common phrase, and a mixed negative Boolean query. Two concurrent
requests completed successfully in that isolate. Startup reported 2.6 MB used
heap and 27.3 MB backing storage. The largest sampled sum of used heap, backing
storage and embedder heap was about 104 MiB. These are inspector observations,
not a guaranteed peak or Cloudflare retained-memory measurement. Forced GC was
unavailable, so the quiescent samples include collectable objects. The remaining
margin beneath the platform's 128 MB isolate limit needs load validation.

The broad common phrase still consumes the shared-cache operation budget in a
single prime; the memory-reuse condition therefore makes about 16.6 MiB of
origin reads. Three bounded shared priming passes eliminate those reads, as
shown separately. It would be misleading to call the former an ordinary warm
cache miss or to remove the budget from the comparison.

Metadata filtering is preserved. The four existing columns (`date_filed`,
`precedential_status`, `opinion_id`, `cluster_id`) keep their immutable payloads.
The conversion preserves internal IDs and corpus order, so only their manifest
binding changes to the new search generation. Its new identity is
`47dce7d8dfcecb4430c167de182de62c8413a19497574707bae980c3ba62d512`.
All eighteen deployment references pass locally (thirteen regression cases and
five held-out cases), including filtered exact totals, an empty date range, and
filtered search-after with a generation-correct cursor.

Machine-readable results, complete counters, CPU/allocation profiles, contracts,
and source/corpus provenance accompany this report under
`results/columnar/verification-1m/`.

## Live Worker comparison

The trial is deployed at
[work-search-cws-verification-1m](https://work-search-cws-verification-1m.phulin.workers.dev).
The existing [1M endpoint](https://work-search-cws-1m.phulin.workers.dev) remains
unchanged as the live control. Its version is
`177b51f3-545b-4a15-b95b-31147bd9f142`; the candidate's is
`ba6c009f-31b7-47cc-8be4-e9192830bbef`. The live control predates the frozen
local control. Live improvements therefore include earlier planner and compact
format changes; they cannot be attributed solely to document verification.
The local comparison above isolates this iteration more closely.

Publication verified and acknowledged 8,420 immutable objects, totaling
22,217,938,010 raw bytes, in about 58 minutes. The deployed bundle was
26,802.57 KiB uncompressed / 21,364.71 KiB gzip; Cloudflare reported 13 ms startup.
The first search following deployment took 4,718 ms and returned correct full
results. It ran before the benchmark secret propagated, so it has no authenticated
CPU/counter telemetry. The second probe took 1,234 ms and was also correct. These
startup observations are distinct from an application-cache reset.

The live pilot ran in BOS on November 14, 2026, with randomized/interleaved
variant and query order. Eighteen scenarios ran in three sessions under fresh
application/shared namespaces, immediate repetition, and shared-page reuse with
an in-request application-memory reset. This produced 324 complete responses.
The load pilot added 96 measured requests and twelve priming requests: **432/432
passed correctness, with native CPU and wall observations joined for all 432**.
There were no errors, timeouts or resource rejections. Responses include metadata,
query-relevant snippets and requested exact totals; response caching is disabled.

Only 5 of 108 immediate-repeat pairs reached the same isolate. Those observations
must not be labeled application-memory-warm. Shared-page reuse also does not
guarantee that every page is cached: the control's common phrase still read
30.75 MiB from R2 after hitting the operation budget, while the candidate read
none. Opaque R2 backend caches were neither controlled nor claimed to be cold.

The table reports complete-response **medians in milliseconds**, three samples
per query/variant/condition, control → new. Per-cell observed ranges and all work
counters are in `live-summary.json.gz`. These small samples do not establish
production percentiles or confidence intervals.

| Query                                                                 | Fresh namespaces | Shared reuse, application empty | Fresh origin MiB | Fresh R2 GETs |
| --------------------------------------------------------------------- | ---------------: | ------------------------------: | ---------------: | ------------: |
| Summary judgment + arbitration + third-party beneficiary, exact total |    6,080 → 1,699 |                     1,604 → 535 |     75.88 → 3.93 |     270 → 135 |
| Requests for admission + phrase OR                                    |    6,647 → 7,079 |                   1,774 → 1,306 |    37.87 → 15.14 |     294 → 452 |
| Mandate rule + Boolean conditions                                     |      2,397 → 423 |                       977 → 130 |     12.76 → 0.52 |      194 → 12 |
| Burden of proving                                                     |    4,179 → 5,331 |                     1,477 → 788 |    47.85 → 24.28 |             — |
| In the absence of                                                     |  11,417 → 10,623 |                   4,709 → 2,228 |  195.31 → 124.78 |     799 → 493 |
| Statute of limitations + affirmative defense + Rule 16 + diligence    |    1,173 → 2,146 |                       671 → 743 |      6.21 → 1.57 |             — |
| Mixed negative Boolean                                                |    4,493 → 5,302 |                     1,526 → 788 |    34.15 → 13.74 |             — |
| Filtered arbitration                                                  |    8,191 → 3,615 |                     2,226 → 995 |     72.47 → 6.68 |     617 → 218 |
| Filtered search-after                                                 |    7,918 → 3,788 |                     2,002 → 847 |     71.99 → 6.69 |             — |

The admission regression is actionable: 407 candidate records become 407 numeric
reads, with 452 total origin reads after planning and rendering. Reduced bytes
alone do not compensate for that count. Its shared-reuse native CPU also rises
from 652 to 874 ms, despite the wall-time improvement. Warm native CPU improves
for arbitration (592 → 357 ms), the common phrase (1,046 → 860 ms) and mixed
negative Boolean (582 → 394 ms). The common phrase still decodes approximately
1.4 million score postings and takes 66 positional I/O waves. Supplemental pair
positions were not selected, so this run establishes no performance gain from
the new context chunks.

Unfamiliar queries have mixed results too: forum selection regresses 916 →
1,293 ms fresh; failure to exhaust improves 5,850 → 4,572 ms fresh but regresses
1,397 → 1,545 ms with shared reuse. Clear-error and equitable-tolling exact-total
queries improve in both conditions. The raw report retains every scenario,
including zero hits, fields, filtering and pagination.

The finite load pilot equally mixes arbitration, admission and mixed negative
Boolean. There are 24 requests per variant/rate, with arrival rates of 0.5 and
2 requests/second. These workload quantiles must remain separate from the
per-query results and from production traffic:

| Arrival rate | Client P50 control → new |              P95 |              P99 | Drain throughput, requests/s |
| ------------ | -----------------------: | ---------------: | ---------------: | ---------------------------: |
| 0.5/s        |           1,721 → 883 ms | 2,451 → 1,695 ms | 2,624 → 2,065 ms |                0.498 → 0.507 |
| 2/s          |           1,554 → 924 ms | 2,731 → 1,513 ms | 2,992 → 1,535 ms |                1.686 → 1.987 |

At this sample size P99 is the maximum, not a reliable tail estimate. This is
not a steady-state capacity test. Maximum client launch lag was 2.71 ms; the
application reported no admission queueing. Cloudflare's internal queueing is
not separately observable here. Candidate load requests made zero to two R2
reads; shared pages supplied almost all I/O.

Account checks during publication and after the pilot showed no resource errors
and 19 scripts against the documented 500-script allowance. Bucket/account totals
include other work. Candidate memory analytics remained unattributed, so the
anonymous memory series is deliberately not assigned to this Worker. Native
candidate peak and retained memory remain unestablished; local workerd inspector
samples and explicit buffer/cache accounting are provided separately. There is
no multi-region result in this pilot.

## Correctness and practical limits

The final full suite passed 304 tests in 83 files. Independent exhaustive references passed 160 cases,
including field boosts, negatives, positional conditions, and search-after.
The 200-query control comparison checks ranked IDs/order, rendered metadata and
snippets, exact totals when requested, and scores within a relative tolerance of
1e-11. All 800 measured 200-query responses and all 340 matrix responses passed.
`yarn run check` and formatting checks passed.

Counters distinguish raw retained pages, decoded retained blocks, active query
buffers, expanded bytes, repeated decoding, numeric document reads, and display
reads. Active-buffer counters are accounting estimates, not measured native
peak heap. Neither cumulative decoded bytes nor sampled allocation can be
reported as retained or peak memory.

The current broad positional path and its page amplification remain. The
redesign is not evidence of 10M performance, and this iteration does not add
selected three/four-word phrase postings, a separate unigram membership layer,
or document reordering. This is a functioning 1M trial, **not ready for full-corpus
adoption**. Cold regressions, admission CPU, useful positional coverage, stronger
load/tail evidence and native memory headroom still need resolution.
The bundled document locator directory also needs a measured larger-corpus
capacity check; the successful 1M bundle does not establish its fit at 10M.

Platform limits were checked against the current [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
64 MiB uncompressed bundle, 128 MB per isolate, six connections waiting for
response headers, and 1,000 Cache API operations per request. The 900-operation
application budget remains in place. The reader currently holds its six slots
through body consumption; this is more restrictive than the platform's header
limit. No service-binding fanout is used as presumed CPU parallelism.

## Reproduction

Use Yarn and the retained local 1M corpus/index. The obsolete original download
mirror was removed after verifying that both the new index and frozen control
are independent of it. The local migration and control builders are diagnostic
tools; production corpus construction uses `scripts/build-in-workers.ts`.

```sh
yarn node --import tsx bench/columnar/run-verification.ts work/verification-1m work/io-iteration/contract.json
yarn node --import tsx bench/columnar/report-verification.ts work/columnar-bench/verification-measured-empty.json.gz work/columnar-bench/verification-measured-reuse.json.gz work/columnar-bench/verification-measured-shared.json.gz
yarn run check
yarn test
```

Publication is immutable and resumable. Search deployment follows complete
object identity/coverage checks and targets a separate benchmark Worker.

```sh
yarn node --import tsx scripts/publish-local-columnar.ts work/verification-1m --membership work/verification-1m
CWS_MEMBERSHIP_DIR=work/verification-1m yarn node --import tsx scripts/deploy-columnar.ts work/verification-1m work-search-cws-verification-1m --deploy-only
CWS_VARIANTS=work-search-cws-1m,work-search-cws-verification-1m CWS_LABEL=verification-live CWS_DRIVER=bench/columnar/io-live.ts yarn node --import tsx bench/columnar/with-tail.ts https://work-search-cws-1m.phulin.workers.dev https://work-search-cws-verification-1m.phulin.workers.dev work/verification-live-contract.json work/columnar-bench/verification-live.json.gz
yarn node --import tsx bench/columnar/summarize-verification-live.ts work/columnar-bench/verification-live.json.gz work/columnar-bench/verification-live-cpu.json.gz work/verification-live-summary.json
```

For this order-preserving migration, `rebind-verification-metadata.ts` reuses the
existing metadata columns only after checking the source generation, corpus,
analysis, document count and conversion receipt. New/reordered corpora must build
metadata against their actual internal IDs; the rebinding helper is not a generic
way to ignore generation mismatches.

The next priority is reducing necessary read count: compare the exact document
and term continuations using observed GET/wave cost, then coalesce useful numeric
ranges where candidates share storage. Broaden corpus-selected positional pair
coverage beyond the current ineffective pool and coalesce tiny adjacent context
chunks. Recheck admission CPU before promotion. Another round of ranking-bound
tuning cannot remove these verified-candidate and exact-total costs.
