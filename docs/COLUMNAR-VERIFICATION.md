# Document verification and pair positions

The serving engine retains its term-oriented score/position streams for broad
queries. Selective queries instead use a document-oriented inverted index. Both
represent the same normalized terms and exact positions; physical document IDs,
the ranking formula, field lengths, and tie order are unchanged. Membership is
represented by sorted integer lists. There are no document-membership bitmaps.

## Document records

`document-package.ts` writes CDP4 records into immutable document containers.
The bundled CDD2 document directory carries each record's address, initial-prefix
length, and complete numeric-verification byte budget. No remote locator lookup
is required. Numeric verification and presentation occupy disjoint ranges.

The 64-byte record header describes field lengths, a term-block directory,
frequency blocks, positions, compressed display metadata, the existing passage
directory, and the existing compressed passage data. The term-block directory
contains a last term ID and offset/length/count for each group of at most 128
terms. Each group contains packed term IDs, body/title frequencies, and directly
readable position offsets. Position spans use the compact integer codec and
restart independently for every term and field.

For a numeric record no larger than the complete-read threshold, the initial read
contains all its numeric data. For larger records, the initial read contains
only the header and term-block directory. The executor fetches selected frequency
blocks in parallel, then the required stable position chunks in parallel. It
never scans a forward token array to find a query term. Position chunk sizes of 16, 32, and 64 KiB are supported. The complete-numeric
first-read threshold is recorded in the bundled document directory and can be
changed by rebuilding that directory without rewriting document payloads.

Candidate verification does not fetch display metadata or text. Winners fetch
metadata and the existing independently compressed passage chunks by direct
range address. The passage selection and excerpt construction remain unchanged.
The container is shared to avoid a second locator directory, but no serving
verification range extends into its presentation sections.

The planner prices complete numeric-verification bytes rather than the old
whole-document size. The rolling candidate pipeline bounds active reservations
and retained winners; cumulative transferred bytes do not determine eligibility.
Small winner presentation tails (up to 64 KiB) are coalesced into one range;
larger tails retain selective passage reads. This adds no display reads for
rejected candidates and does not change excerpt selection.
When result retrieval first opens a winner whose entire record is at most
64 KiB, it requests that complete record in one range. This avoids a numeric
prefix followed by a second small display read. Candidate verification never
opts into that policy.
Readers share generation-scoped bounded raw-range caches and in-flight reads.
Decoded term and position arrays remain query-local. Winner retention drops
decoded arrays and shares the validated raw buffers.

## Pair positions

Complete pair membership remains independently useful. A pair record can contain
its existing inline context or a CPR1 positional directory. The latter gives
document intervals and direct addresses of independently decodable context
chunks. Chunks contain at most 128 distinct documents, are bounded by encoded
bytes, and split individual very long document rows when needed. Each occurrence
retains its position and adjacent token IDs, separately by field.

The query executor first obtains conservative Boolean candidate memberships.
It then computes the selected positional chunks and their complete byte cost
before issuing any supplemental context reads. The initial policy allocates at
most 4 MiB and at most half the estimated document verification bytes. Unselected
records are unknown and use the exact ordinary verification path. Selected
chunks are fetched together and feed evidence directly into the Boolean
continuation. Context can prove covered two-, three-, and four-token phrases;
uncovered phrase/proximity conditions still require exact positions. Ranking
continues to use constituent-word scores. This budget applies to optional
candidate enrichment. The [complete phrase executor](EXACT-PHRASES.md) can
instead select a whole context stream as a primary matching source, with an
active-memory bound rather than a cumulative 4 MiB transfer cutoff.

The complete context builder streams existing occurrence partitions and writes
sorted context chunks into immutable 32 MiB containers for every pair without
inline context. It has no frequency-rank or storage-budget coverage cutoff.
The [complete phrase design](EXACT-PHRASES.md) describes routed EPR1 extents,
bounded construction, coverage validation and independently executable phrases.

## Construction

Production document construction writes CDP4 directly from corpus partitions.
`scripts/build-exact-phrases.ts` builds complete context and rewrites routed
membership packets with direct extents. Construction validates pair counts,
field counts, generation identity, and coverage before publication. Local
migration and comparison helpers remain under `bench/columnar`; their generated
inputs and outputs are kept outside version control.
