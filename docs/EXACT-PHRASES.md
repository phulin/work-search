# Independently executable phrases

The search engine can establish a two-, three-, or four-token phrase from one
complete pair-position stream. A pair records its occurrence position and the
normalized token immediately before and after it, separately by field. For a
four-token phrase only the middle pair covers the whole expression. For three
tokens either edge pair can cover it. Longer phrases retain ordinary exact
verification; no partial context is treated as proof.

The first construction covers all 2,000 corpus-ranked common pairs, independent
of benchmark queries and the N=100/M=1000 candidate exclusions. Every selected
pair has all its document memberships and occurrences. Other pairs keep their
existing membership/inline-context products and exact fallbacks. This is not a
claim of positional coverage for the entire observed pair vocabulary.

## Format and construction

`exact-phrases.bin` is an EPD2 bundled directory. Its header contains a generation,
base search generation, document count and immutable positional-object inventory.
A sorted, exact-string pair dictionary holds field document/occurrence counts,
numeric term IDs and contiguous physical extents. Existing pair membership,
document verification, scoring and presentation objects are unchanged.

The positional payload uses the existing independently decodable pair packets,
bounded by 128 documents and encoded bytes. Packets are self-framing. Complete
execution therefore needs extent addresses, not one bundled route per packet.
The builder retains fine restart directories separately for selective uses.
The 1M construction's fine directories occupy 31.6 MB; the serving directory
occupies 145,835 bytes. That distinction avoids spending isolate memory on
routes a complete scan does not need.

The builder streams complete-pair occurrence partitions and emits 32 MiB immutable
containers. It verifies each selected pair's total and per-field document and
occurrence counts against the membership source, including split long rows.
Generation checks bind the positions to their term IDs and original document
order. An order-preserving conversion requires matching construction receipts.
No corpus text is read during query verification.

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
yarn node --import tsx scripts/build-exact-phrases.ts \
  work/columnar-complete-pairs-1m work/exact-phrases-all-1m work/verification-1m

# Validate selection against an already-built generation without rebuilding.
yarn node --import tsx scripts/build-exact-phrases.ts \
  work/columnar-complete-pairs-1m work/exact-phrases-all-1m work/verification-1m \
  65536 --verify-selection

CWS_EXACT_LABEL=exact-phrases-final \
  yarn node --import tsx bench/columnar/run-exact-phrases.ts

# Publish only this independent context generation, then deploy an isolated trial.
yarn node --import tsx scripts/publish-exact-phrases.ts work/exact-phrases-all-1m
CWS_MEMBERSHIP_DIR=work/exact-phrases-all-1m \
  yarn node --import tsx scripts/deploy-columnar.ts \
  work/exact-phrases-all-1m work-search-cws-phrase-1m --deploy-only
```

Local comparisons expect the separately frozen pre-change source and base index
views described in the benchmark report. The builder and serving runtime have no
dependency on that benchmark control.

## Rejected experiments and remaining costs

A small storage-budget selection omitted useful complete phrase sources. The
initial experiment instead builds the whole corpus-ranked common-pair pool.
Per-chunk bundled directories were replaced with extents. Per-document async
emission was replaced with numeric batches. Repeated binary searches while
building candidate masks were replaced with numeric Boolean truth columns.

Forcing a global pair scan displaced cheap candidate-document continuations and
regressed admission and Rule 16. The normal path now retains those measured
alternatives. Exact phrase execution still leaves scoring work: broad match sets
can touch many score pages and fetch waves. This change does not redesign the
score layout, context encoding, presentation format or excerpt algorithm.
