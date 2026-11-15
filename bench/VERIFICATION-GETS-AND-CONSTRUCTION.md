# Fewer verification GETs and construction PUTs

Control: `750e9e8`, frozen separately in `work/verification-gets-control`.
The retained 1M corpus, complete pair context, scoring, presentation and snippets
are unchanged. Serving format stays CDP4/CWS1. Staging descriptors now support
ranges inside larger immutable objects; final document groups contain more of
the identical records. No bitmap index or candidate truncation.

## Candidate verification

The old candidate enrichment path supported the older positional chunk directory
but skipped complete-context streams. The replacement prices the selected pair's
complete stream against candidate-document GET waves. It reads contiguous extents
in 256 KiB ranges, with six requests in flight, inspects chunk membership and
decodes positions only for candidate documents. It retains only those rows,
including every fragment of a document split across chunks or GET boundaries.
The original Boolean pair tree is reevaluated with the resulting exact/partial
context evidence before document verification and score retrieval.

This optional refinement applies only after the existing planner chooses document
verification, with at least 128 candidates. That is a cost heuristic, not a result
limit: every candidate continues through exact execution if refinement is skipped
or its retained-memory budget is exhausted. Two-word membership needs no extra
context for Boolean matching. Field boundaries, negative branches and proximity
still use the ordinary exact evaluator. Only verified matches affect top-K.

An initial implementation refined before choosing the continuation. It improved
the worst document queries but regressed leave-to-amend/futility from 570 to
1,102 ms by switching a good postings plan into 218 document reads. That version
was rejected. Its full raw comparison is retained separately; the final version
first chooses the baseline continuation and preserves efficient postings plans.

Simple document-range coalescing was rejected as the primary fix. Admission's
407 verification GETs touch 380 objects. Allowing 1 MiB gaps reduces those GETs
to 383 while increasing verification transfer from 9.5 to 17.3 MiB. The useful
change is rejecting candidates before their records are opened.

## Construction

Small 2 MiB sorted-run decode blocks are packed into 16 MiB immutable staging
objects. A descriptor carries the logical range and checksum; merge readers
fetch and validate that range rather than buffering its whole container.
Ingestion requests may cover 512 documents with a 1M-token budget, retaining
128-document source prefetch windows. Time/token continuations still apply.
The number of source documents never determines whether a document is omitted.

Term metadata emits 512-entry blocks instead of 128. Document jobs cover up to
1,024 documents, with a 16 MiB physical-group target and 4M-token work budget.
A record that would overflow a nonempty group is left for the next continuation.
An indivisible large record runs alone. Group CRC metadata is removed; immutable
SHA identities and package/section validation remain. The package bytes and
excerpt algorithms are unchanged.

Actual Worker-handler calls against a counting local R2 implementation, using
the first 4,096 real documents from the retained 1M corpus:

| Pass | Control PUTs | New PUTs |
| --- | ---: | ---: |
| Ingest | 96 | 16 |
| Ingest plus sorted merges | 184 | 23 |
| Document groups | 64 | 8 |
| Staging plus document groups | **248** | **31** |

The final row includes receipt PUTs: **87.5% fewer writes**. Do not add the first
two rows; merging includes ingestion. The merged sorted byte stream and all
4,096 per-document package hashes agree exactly. This is a measured construction
sample, not a whole-1M or full-generation PUT count. Postings finalization,
vocabulary/directory preparation and complete-pair construction are outside
that measured denominator. The metadata block change separately reduces full
blocks' PUT count by 75%; full-generation totals must be observed during the run.

The sample takes 15.65 versus 14.21 seconds, one observation per version, without
simulated network delays. Its bucket holds source/generated objects in the host
Node process; sampled RSS includes both variants and is not Worker peak memory.
The timings are diagnostic, not evidence of a native construction speedup.

Constructor telemetry now counts actual R2 method calls, separating PUTs from
GETs and including receipts, retries and reused requests. The old mixed
`writesAndMergeReads` counter remains for reading historical logs.

## Full corpus source

The complete archived snapshot contains 10,901,752 nonempty opinions. A new
coordinator filters issuing courts using the local cluster/docket/court join,
including explicit corrections for administrative bodies in judicial categories.
AG reports, executive/administrative boards, commissions, private arbitration,
test issuers and unknown courts are excluded. Actual judicial special courts and
historic judicial appeal bodies are explicitly included. Individual opinion
titles are not used as an institutional classifier.

Metadata selection reads no opinion text. Each retained source partition gets
one new compact ordinal/pointer map; content and metadata bytes stay in their
existing immutable archive objects. The filtered source receives contiguous new
internal IDs in the same relative source order. Corpus statistics and scoring
are rebuilt for that filtered corpus. Exclusions are recorded by issuing court
and reason, including unknown issuers.

The coordinator invokes one construction Worker repeatedly, using a bounded
client window, and captures account/bucket usage every 15 minutes. These requests
do not imply independent CPU parallelism; isolate and queue telemetry remain
available. Source filtering is resumable per archive partition. The serving demo
is never deployed or modified by this command.

```sh
yarn node --import tsx scripts/build-court-corpus.ts work/court-cases-full
```

The coordinator builds the full filtered **base index**. Complete-pair/context
construction and full-corpus serving/load validation remain subsequent stages;
`base-index-complete` does not mean adoption-ready. Construction still runs in
Workers/R2, without Containers or Durable Objects. The current documented
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
are 128 MB per isolate, 64 MiB uncompressed bundles and up to five minutes of
paid HTTP CPU. Six connections may be waiting for response headers simultaneously;
this is not a limit of six bodies being consumed. The new staging containers do
not increase the input decode block size.

## Measurement and validation

Only cold application/shared caches are measured. No response caching. Complete
responses include metadata, matching snippets and JSON serialization. The local
model remains 20 ms origin plus 100 MiB/s, six request slots, 2 ms shared-cache
operations, 12 MiB application pages, 4 MiB decoded data and a 900-operation shared
budget. Filesystem and JIT reuse are not a new Worker isolate or controlled R2
backend caching. Node process CPU is not native Worker CPU.

The performance contract has all 200 exact totals off. Engines are randomized
and interleaved, three observations per query/engine. Reported query quantiles
describe that workload, not production traffic or reliable tail probabilities.
The separate 160-query exhaustive oracle and focused cases retain exact totals
where required. Source digests are checked around measured runs.

The final comparison contains 1,200 complete, correct responses. Quantiles below
are across the 200 per-query medians, three cold observations per engine:

| Cold workload statistic | Control ms | New ms |
| --- | ---: | ---: |
| P50 | 386 | 385 |
| P95 | 1,023 | 1,017 |
| P99 | 1,827 | 1,261 |

| Query | Control ms | New ms | Verification GETs before → after | Total MiB before → after |
| --- | ---: | ---: | ---: | ---: |
| Requests for admission / application of law | 1,993 | 1,067 | 407 → 167 | 15.14 → 8.72 |
| Intervention | 1,988 | 1,286 | 428 → 245 | 8.93 → 6.36 |
| Withdrawal | 1,827 | 869 | 384 → 20 | 9.37 → 14.37 |
| Consent decree | 1,254 | 1,261 | 262 → 262 | 7.01 → 7.01 |
| Rule 106 | 1,186 | 1,196 | 265 → 265 | 2.99 → 2.99 |

Admission's local process CPU falls from 587 to 370 ms, intervention from 479
to 320 ms, and withdrawal from 497 to 356 ms. Position integers fall respectively
66,785 → 23,247, 35,097 → 22,398 and 24,895 → 5,332. Withdrawal switches to
postings after refinement: its 20 remaining verification reads are for winners,
but total transfer increases. This is a latency/bytes trade, not universal byte
reduction. Leave-to-amend/futility now takes 570 → 539 ms with identical reads.

No query regresses by both more than 10% and more than 10 ms. Smaller observed
regressions remain: 1407 centralization 707 → 738 ms, collateral attack 620 →
647 ms, Rule 11 safe harbor 345 → 371 ms, letters rogatory 590 → 614 ms, and
Rule 15 prejudice 573 → 595 ms. Their GET counts are unchanged; three samples
cannot establish the cause or stability of these differences. Consent decree
and Rule 106 still read about one verification record per candidate: their
two-word phrases already have matching evidence, so this refinement adds none.

The next query experiment should address those scattered candidate-record reads
directly, comparing stable range coalescing against an earlier numeric-only
continuation on their actual physical footprints. Broader context scans should
not become the default. Full-corpus construction must also report actual PUTs
by stage before the sample's 87.5% reduction can be generalized.

Evidence: [machine-readable results](results/columnar/verification-gets-1m/).
Construction replay: `yarn node --import tsx bench/columnar/construction-puts.ts`.

Validation: 87 test files / 322 tests pass, including workerd integration,
candidate-context split/field/budget tests, range-backed merge checks, filtered
source identity/ordinal tests and court classification tests. The independent
160-query oracle and 29 focused cases pass. Typechecking and changed-file
formatting checks pass.

To reproduce the cold comparison, archive `src` and
`bench/columnar/local-storage.ts` from control `750e9e8` under
`work/verification-gets-control`, and link its `index/{root.json,directory.bin,
documents.bin}` to the retained index and `index/pairs` to that index directory.
The frozen runtime and current runtime then share identical data:

```sh
CWS_CONTROL_SOURCE=work/verification-gets-control \
CWS_CONTROL_RUNTIME=frozen \
CWS_CONTROL_INDEX=work/verification-gets-control/index \
CWS_LOCAL_DATA=work/complete-context-v2-1m \
CWS_PAIR_INDEX=work/complete-context-v2-1m \
CWS_PLANS=control-N100-M1000,auto-N100-M1000 \
CWS_REPEATS=3 CWS_PRIME_PASSES=1 \
CWS_LABEL=verification-gets-final-200 \
CWS_ISOLATE_SCENARIOS=1 CWS_CONDITION=fresh-namespace \
yarn node --import tsx bench/columnar/simulate.ts \
  work/complete-context-v2-1m work/io-iteration/expanded-contract.json
```

The contract is also preserved in the earlier phrase-planner evidence as
`expanded-200-contract.json.gz`. No priming runs execute under fresh-namespace;
the generic harness's warm-condition settings are irrelevant here.
