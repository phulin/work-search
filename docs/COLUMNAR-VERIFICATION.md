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
never scans a forward token array to find a query term. Chunk sizes of 16, 32,
and 64 KiB are supported; the first full 1M construction uses 32 KiB position
chunks and a 1 MiB complete-numeric first-read threshold. A 32 KiB threshold
was rejected after simulated reads exposed excessive dependent requests for
long candidates; 128 KiB still added dozens of reads to some candidate sets.
Every numeric record in the retained 1M corpus fits below 1 MiB (the largest is
606,182 bytes). The threshold can change by rebuilding the bundled document
directory, without rewriting document payloads.

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

The offline positional builder selects from corpus pair statistics, without
reading benchmark queries. It streams existing occurrence partitions, reserves
a conservative encoded-size bound under a storage budget, and writes sorted
context chunks into immutable 32 MiB containers. This initial selection pool is
the corpus's 1,000 most frequent pairs whose context was not already inline;
expanding the pool is separate from changing the packet format.

## Construction and experiments

Production document construction writes CDP4 directly from corpus partitions.
`bench/columnar/rebuild-compact.ts` is a local migration tool for the retained
1M corpus; obsolete decoders are imported only from a separately frozen source
tree, not retained in production. Its document conversion is bounded to one
source container and one output document group, plus one document's working
arrays. Term conversion uses bounded caches and an on-disk SQLite directory.

`scripts/build-pair-positions.ts` builds supplemental context.
`bench/columnar/attach-pair-positions.ts` rewrites affected membership packets and
publishes their positional object inventory in the bundled router.
`bench/columnar/build-verification-control.ts` reconstructs the frozen CDP3
arrangement with exactly the candidate's compressed passage bytes, so format
comparisons do not measure an excerpt change. The simulation harness supports
separate control and candidate roots on identical corpus input.

Rejected approaches: fetching full document text for rejected candidates;
retaining a second legacy production decoder; scanning complete token arrays
for selective verification; fetching an arbitrary number of context chunks
before deciding whether they are economical. Broad buffered pair-position scans
are now implemented by the complete phrase executor. Separate selected phrase
postings, document reordering and a new word-membership layer remain future
experiments.
