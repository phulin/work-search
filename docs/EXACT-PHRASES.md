# Independently executable phrases

The search engine can establish a two-, three-, or four-token phrase from one
complete pair-position stream. A pair records its occurrence position and the
normalized token immediately before and after it, separately by field. For a
four-token phrase only the middle pair covers the whole expression. For three
tokens either edge pair can cover it. Longer phrases retain ordinary exact
verification; no partial context is treated as proof.

Every observed pair has complete positions and one previous/next token per
occurrence, separately by field. On the retained 1M corpus this covers
44,995,185 pairs and 1,497,515,111 occurrences. The 44,529,289 small pairs retain
their complete inline context; every remaining pair (465,896) has a complete
external stream. N=100/M=1000 affects candidate planning only, never storage.

The bundle contains hot descriptors for 2,000 corpus-ranked pairs. This is a
metadata allocation, not a coverage limit. All other descriptors are reached
through the bundled pair router, using normalized strings before numeric term
lookup. A routed packet contains exact identity, membership, counts and either
complete inline context or direct extents for the complete external stream.

## Format and construction

`exact-phrases.bin` is an EPD2 bundled directory. Its header contains a generation,
base search generation, document count and immutable positional-object inventory.
A sorted, exact-string pair dictionary holds hot field document/occurrence
counts, numeric term IDs and contiguous physical extents. EPR1 descriptors
provide the same complete-stream addresses inside routed membership records.
Document verification, scoring, presentation and the context payload encoding
are unchanged.

The positional payload uses the existing independently decodable pair packets,
bounded by 128 documents and encoded bytes. Packets are self-framing. Complete
execution therefore needs extent addresses, not one bundled route per packet.
This avoids bundling a route for every chunk or a descriptor for every pair.
Complete external streams occupy 14,905,267,963 bytes in 889 immutable objects.

The builder streams complete-pair occurrence partitions and emits 32 MiB immutable
containers. It verifies every external pair's total and per-field document and
occurrence counts against the membership source, including split long rows.
Generation checks bind the positions to their term IDs and original document
order. An order-preserving conversion requires matching construction receipts.
No corpus text is read during query verification. Four local construction
processes handle disjoint partitions. Counted scatter fills one bounded numeric
partition buffer instead of appending millions of small files. Deterministic ID
reservations allow independent, resumable output; they reserve no storage bytes.
The largest numeric partition buffer in this build was 468,664,288 bytes.

## Planning and execution

The planner considers pairs whose context covers the entire phrase before
positional I/O. Its cost model includes encoded bytes, range count, dependent
rounds, occurrence decoding and scoring, and recognizes application-resident
ranges. It compares complete word data and candidate-document alternatives.
These costs select execution only; they never discard matches.

A standalone covered phrase whose alternative is broad selects its source
before optional membership or common-word-filter I/O. Its exact context stream
already supplies those necessary conditions. Selective document plans and
compound expressions retain candidate intersections when they can avoid a
global scan. Singleton context rows are checked directly in their existing
encoding, without allocating three decoded columns per document.

Existing cheap candidate discovery remains useful. If its actual candidate set
selects document verification, the executor retains that continuation rather
than replacing it with a global pair scan. For broader continuations, a covered
phrase becomes an independent exact source. Already-covered inline phrases do
not trigger another scan. This also preserves useful filters on other Boolean
branches.

Each stream prefetches at most six 256 KiB ranges. Range boundaries can cross
packet boundaries; the parser carries at most one incomplete packet. Completed
occurrences are checked in numeric batches, with split documents joined before
emission. Only the active 16,384-document window's exact phrase positions are
retained, together with bounded prefetched encoded data. The limit applies to
active buffers, not cumulative transfer; a sparse phrase with fewer than K hits
still scans and rejects the rest of its complete stream.

Exact phrase truth participates in Boolean candidate filtering before score-block
retrieval. Unknown branches remain conservative; negative supersets are never
subtracted. Exact positions also feed the normal positional evaluator for nested
proximity and Boolean expressions. Repeated tokens and field boundaries retain
their existing semantics. Standalone covered phrases need no second positional
verification pass.

Surviving IDs feed the existing batched score-block/MAXSCORE execution. Each
numeric window groups requests by block. Scores still use the constituent-word
integer frequencies, original BM25 formula, field boosts and deterministic tie
order. Only verified matches update the competitive threshold. Exact totals and
search-after retain their existing behavior. Winner presentation uses the same
metadata, passages and excerpt selection.

Counters separate pair-source bytes/ranges/occurrences from ordinary word-position
blocks and integers, score blocks/postings/waves, winner reads and active-buffer
estimates. Buffer accounting is not a native heap-peak measurement. New local
and live comparisons must distinguish application reuse from shared-page reuse
and a genuinely new isolate.

## Reproduce the retained 1M experiment

The context builder consumes the complete-pair construction's streaming
occurrence partitions, vocabulary and corpus statistics, and the current base
index's membership packets. It does not require an obsolete serving decoder.
Its output links immutable base assets locally and owns its new positional
objects. Retain the base index while using that local view.

```sh
CWS_CONTEXT_CONCURRENCY=4 yarn node --import tsx scripts/build-exact-phrases.ts \
  work/columnar-complete-pairs-1m work/verification-1m work/complete-context-v2-1m

yarn node --import tsx scripts/validate-pair-context.ts work/complete-context-v2-1m

CWS_EXACT_LABEL=exact-phrases-final \
  yarn node --import tsx bench/columnar/run-exact-phrases.ts

# Publish only this independent context generation, then deploy an isolated trial.
yarn node --import tsx scripts/publish-exact-phrases.ts work/complete-context-v2-1m
CWS_MEMBERSHIP_DIR=work/complete-context-v2-1m \
  yarn node --import tsx scripts/deploy-columnar.ts \
  work/complete-context-v2-1m work-search-cws-phrase-1m --deploy-only
```

Local comparisons expect the separately frozen pre-change source and base index
views described in the benchmark report. The builder and serving runtime have no
dependency on that benchmark control.

## Rejected experiments and remaining costs

A storage-budget selection and a subsequent top-2,000 pool omitted useful
complete phrase sources. Both coverage restrictions were rejected; only the
bundled metadata now uses the corpus-ranked hot pool.
Per-chunk bundled directories were replaced with extents. Per-document async
emission was replaced with numeric batches. Repeated binary searches while
building candidate masks were replaced with numeric Boolean truth columns.

Forcing a global pair scan displaced cheap candidate-document continuations and
regressed admission and Rule 16. The normal path now retains those measured
alternatives. Exact phrase execution still leaves scoring work: broad match sets
can touch many score pages and fetch waves. This change does not redesign the
score layout, context encoding, presentation format or excerpt algorithm.
