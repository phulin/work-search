# Native offline CWS1 builder

This is the offline builder for the packed CWS1 index used by the replacement
Worker. The serving Worker remains TypeScript. The builder consumes source JSONL
directly; it does not convert a legacy bundled index or keep the corpus in RAM.
Node.js generates the V8 Unicode category table at compile time. Rust handles the
entire build, including float64 BM25 contributions, compression, sorting, merging,
checksums and publication. There is no Node subprocess in the build's hot path.

## Construction

Input ordinals are internal document IDs. Fixed byte batches (4 MiB by default)
are dispatched through a bounded queue to a fixed worker pool. Each worker parses,
normalizes and tokenizes its batch, interns local term IDs, compresses display and
passage records, and writes an immutable sorted run. Positions are grouped using
counting scatter rather than sorting every occurrence or issuing database inserts.
The run vocabulary uses the serving engine's UTF-16 lexical order.

External merges assign global term IDs and exact document frequencies, reject
duplicate external document IDs, and spill local/global mappings in bounded chunks.
Forward token blocks are then encoded in parallel. Run text and token objects are
hardlinked into the generation on the same filesystem, with a copy fallback across
filesystems. Only small directories containing object references need relocation.
A document-order merge computes scores and emits packed posting columns directly.
It does not write and reread a full scored-postings intermediate. The merger
consumes a cursor until it reaches its next competitor, reducing heap operations.
Posting merge fan-in is bounded by both 512 and the available descriptor limit,
leaving 64 descriptors for other work. Larger inputs spill through additional
bounded merge levels. Vocabulary and mapping merges have fan-in 48.
Posting cursors use 256 KiB buffers. One producer merges, scores and encodes leaves;
the consumer builds bounds, hashes and writes pages. Two bounded channels of 32
blocks transfer and recycle column buffers. A producer error propagates to the
writer; a writer error disconnects queues before joining the producer. The order
of output bytes is identical to the earlier serial writer.

Each stage has checksummed checkpoints. Fresh builds collect temporary-file
hashes below a 1 MiB buffered writer and reuse immutable pack digests, rather than
rereading those bytes to create their first checksum. `--resume` verifies source
record hashes and checkpoint artifacts; a completed generation is validated without rewriting
its immutable objects. An output-directory lock prevents two builders from writing
the same generation. The root is the publication marker. Its generation identifier
hashes the root with an empty generation, including every object's content hash,
so different data, scores, metadata or physical layouts receive different keys.

## Serving representation

- Immutable physical pages: 256 KiB; objects: at most 64 MiB.
- Leaves: at most 128 postings, also split at approximately 64 KiB of positions.
- Independent document-ID, field frequency, float64 score, position and locator
  streams. Positions use block-packed deltas; constant values have zero-bit payloads.
- Hierarchical document-order bounds: fanout 64. Term dictionaries contain 256
  terms per page. The root contains dictionary routing, statistics and 256 frequent
  term heads; common terms do not require a flat whole-corpus leaf plan.
- Forward token-ID blocks and overlapped passage text retain all words and field
  boundaries. Display records and query-relevant passages use independent gzip
  records. Posting execution requires no gzip inflation.
- A direct document locator table supports negative-only expressions and result
  retrieval without rediscovering documents through a positive posting list.

This builder emits the base index. Optional pair accelerators and their corpus
selection policy remain the serving project's separate work; they are not silently
included in these timings. It does not select accelerators from benchmark queries.

## Precision and Unicode

Scores retain the BM25 formula and float64 storage. Native `ln` can differ from V8
in the last bits; approximate FP equality was explicitly accepted. Tests require
matching result IDs and tight score tolerances. Native score contributions are
not quantized. Equal stored scores retain ordinal document tie order. Extreme
near-ties across platforms are a remaining qualification of approximate scoring.

Token normalization is NFKC, followed by Unicode lowercase and the exact V8
`[\p{L}\p{N}]` predicate. The build checks that V8, Rust lowercase and the pinned
normalization library agree on Unicode 17.0. Mismatches fail explicitly. The
exhaustive Unicode check compares all valid scalar values, random strings and
contextual/expansion cases with the existing TS tokenizer and UTF-16 offset tool.
Input must be valid UTF-8 JSON with Unicode scalar strings; Rust's JSON parser
rejects lone surrogate escapes. A preview ending inside a surrogate pair is
rounded to the preceding whole scalar; full text and token offsets are retained.

## Memory, storage and limits

Memory scales with worker count, batch size and bounded merge fan-in, rather than retaining all corpus postings. Run summaries and the final object/root
directory still grow with corpus size. For this real 100k workload, eight threads /
16 MiB batches improve build time at roughly 2–2.5 GiB individual-process peak RSS;
four-thread / 4 MiB batches use less memory. The default remains 4 MiB to keep small
builds parallel. Larger merge read buffers did not improve repeatable results and
were removed. Per-document input is capped at 64 MiB before allocation.
The cap is a guard, not a recommendation: one huge document expands into tokens,
positions and passage buffers. Default batches are soft byte boundaries, so the
last record may exceed the batch budget. Active worker scratch, queued input,
merge cursor buffers and mapping tables all contribute to RSS. Native text
compressors and packing buffers are reused. SHA-256 uses runtime-detected hardware
acceleration on supported ARM machines; x86 retains the library's dispatch.

Final output objects, raw run postings, forward intermediates and checkpoints
coexist until publication. This trades scratch disk for resumability and bounded
RAM. Do not delete run packs before completion: final names may hardlink their
inodes. After a completed build, serving needs `root.json` and `packs/`; the
`staging/` tree is needed only for resume validation. Preserve a manifest separately
if it is used as benchmark provenance. Zero-copy publication is an offline
filesystem optimization, not deduplication of R2 requests.

## Alternatives removed or retained only as controls

The production path has no per-posting SQLite inserts, object-heavy JS postings,
per-occurrence comparison sort, V8 score subprocess, second scored-postings merge,
or whole-generation copy/patch pass. The first Rust implementation is frozen in
`codex/rust-builder-v1-control`; it is not a selectable production engine. The
original CWS1 TS builder and reader under `bench/rust-builder/control/` are frozen
benchmark/reference tooling only. The later optimized control is frozen in `codex/rust-builder-v2-control`.
The rejected large-buffer experiment is preserved only in Git history and its raw
measurements. Gzip remains for text because changing its codec
also changes serving decode support and needs a separate live latency comparison;
the measured offline improvements use libdeflate, not lower-fidelity text.

## Adoption

The real 100k corpus, every-posting synthetic tests, and the existing 32-query
oracle qualify the base format. This work does not establish 1M/full-corpus serving
latency, live Worker memory, or the readiness of the replacement query engine.
External merge structure supports larger inputs, but those sizes need measured
builds and serving validation before full-corpus adoption. Regular files and named
FIFOs use the same bounded source reader; external gzip decompression can stream
without materializing an uncompressed corpus. A FIFO producer must be restarted
for resume validation. Content-derived generation is known only at completion;
the main project's old source-hash streaming uploader needs adaptation before it
can delete and upload native output during construction.
