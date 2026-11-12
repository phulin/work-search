# Binary formats: v5 base, v8 current

All fixed integers are unsigned little-endian u32; offsets are bytes. Objects and individual sections must fit u32. The index file is at most the configured budget (up to 48 MiB). UTF-8 strings have no terminator. Dictionary order is JavaScript UTF-16 lexicographic order, not UTF-8 byte order. Readers/writers must use that comparator.

## Bundle

128-byte header:

| Offset | Value                                         |
| -----: | --------------------------------------------- |
|      0 | u32 magic 0x31535742 (`BWS1`)                 |
|      4 | u32 format version, 5                         |
|      8 | u32 total bundle byte length                  |
|     12 | u32 document count                            |
|     16 | u32 term count                                |
|     20 | reserved zero                                 |
|     24 | f64 average body length                       |
|     32 | f64 average title length                      |
|     40 | u32 dictionary-descriptor start, always 128   |
|     44 | u32 term-string start                         |
|     48 | u32 document-table start                      |
|     52 | reserved zero (v1 ID-section offset removed)  |
|     56 | u32 embedded-posting start                    |
|     60 | reserved zero                                 |
|     64 | 64 ASCII hex characters of generation SHA-256 |

Each term descriptor is **40 bytes**, with u32 fields at these byte offsets:

| Offset | Field                                                  |
| -----: | ------------------------------------------------------ |
|      0 | Term-string offset relative to the term-string section |
|      4 | Document frequency                                     |
|      8 | Frequency object number (`0xffffffff` = bundled)       |
|     12 | Frequency offset                                       |
|     16 | Frequency byte length                                  |
|     20 | Frequency CRC32 (directory CRC for blocked lists)      |
|     24 | Position object number (`0xffffffff` = bundled)        |
|     28 | Position offset                                        |
|     32 | Position byte length                                   |
|     36 | Position CRC32                                         |

Term-string end is the next descriptor's string offset, or document-table start for the final term. Each local offset is relative to embedded-posting start, regardless of stream kind. Each remote offset is relative to its own object. Frequency and position streams may be embedded independently; no remote descriptor lookup is needed. Dictionary size grows by twelve bytes per term compared with v3.

## Compressed document table

The section from `document-table start` to `embedded-posting start` is self-contained. Documents retain input order; there is no separate raw ID-string section and no remote lookup for external IDs.

The table begins with four u32 values: magic `0x32435444` (`DTC2`), restart block size **32**, document count, and block count (`ceil(count/32)`). Next are `blockCount+1` u32 byte offsets relative to the table, followed by `blockCount` CRC32 values. The first offset equals the complete directory size; the sentinel equals section length. An empty corpus still has a 20-byte table.

Each block starts with a 20-byte header:

| Offset | Value                                  |
| -----: | -------------------------------------- |
|      0 | u32 minimum body token count           |
|      4 | u32 minimum title token count          |
|      8 | u8 body delta bit width (0–32)         |
|      9 | u8 title delta bit width (0–32)        |
|     10 | u16 actual block document count (1–32) |
|     12 | u32 initial metadata object number     |
|     16 | u32 initial metadata byte offset       |

Body deltas and then title deltas follow, each in a separate byte-aligned bit-packed array. The width is `ceil(log2(max-min+1))`, or zero for constant values. Values start at consecutive `i*width` bit positions, with low-order bits stored first. Array byte length is `ceil(count*width/8)`. Adding a document's packed delta to its field minimum yields its exact u32 length. Length reads use the directory and a fixed-size last-block header cache; they do not scan IDs or expand the document table. Constant-length blocks store only the two minima.

Variable-length records follow the packed lengths, one per document:

1. Varint common UTF-8 byte-prefix length against the previous ID within this block (zero for the first ID).
2. Varint suffix byte length, then the suffix bytes.
3. Varint metadata pointer tag: `0` uses the current object/offset; `1` is followed by absolute varint object and offset. Other tags are invalid.
4. Varint metadata length. The next current offset becomes this record's offset plus length.

Prefix comparisons may split a multibyte character; only the fully reconstructed ID is decoded as UTF-8. This preserves arbitrary valid Unicode IDs without sorting or changing internal IDs. A zero metadata tag captures contiguous records; exceptions handle object transitions, gaps and nonmonotonic locations. The block header provides a full restart for both IDs and pointers. Random document retrieval scans at most 32 records, and only top-K winners need IDs during ranking. Remote metadata ranges still hold individual JSON objects `{id,title?,metadata?}`.

The directory and block geometry are checked before accessing a block. Each block's CRC covers its header, packed lengths, IDs and pointers; validation is lazy and remembered in one bit per block (3,907 bytes at one million documents). No document arrays or ID maps are built during Worker startup. Runtime length access caches only the last header in seven numeric scalars; no document-length arrays are expanded. Constant columns return their minima directly, while varying columns extract up to five bytes using bit operations. The length-access optimization remains unchanged in v4; the document-table subformat is still DTC2. Bundle bytes must remain immutable after construction. Corrupt widths, overflowing values, invalid prefixes/pointer tags, truncated records and trailing bytes at a block's end are rejected.

## Independent posting streams

The following payload encoding applies to terms with df <= 256 and to each restart block of larger terms. All compressed integers use canonical unsigned LEB128 (maximum five bytes / u32). Frequencies and positions are separately encoded, checksummed, embedded and packed into immutable objects. The v3 interleaved codec remains only as a frozen-reference/test helper and is not used by the deployed v5 query path.

### Frequencies

A list begins with varint document frequency, then exactly that many triples `(document-ID gap, body TF, title TF)`. First document gap is its absolute internal ID (possibly zero); subsequent gaps must be positive. At least one TF must be positive. **No position bytes, position lengths, or offset tables occur in this stream.** The decoder validates its CRC, counts, varints, sorted IDs, u32 overflow and trailing data. It allocates only three u32 arrays: IDs and two TFs. It records the frequency CRC for binding a position stream later. Empty lists encode a single zero byte.

### Positions

A position list begins with varint document frequency and a fixed four-byte little-endian **CRC32 of the complete corresponding frequency stream**. In frequency posting order, it then stores exactly `body TF` body-position gaps and `title TF` title-position gaps for each document. Counts are supplied by the already decoded frequency stream; they are not duplicated in the position payload. First position gap within each field/document is its absolute zero-based token index (possibly zero); subsequent gaps must be positive. Deltas restart independently for body/title and every document. An empty list still has the count plus four-byte binding CRC.

The reader validates the position list's own dictionary CRC and its frequency binding before accepting data, then verifies count agreement, position ordering, overflow, truncation and trailing bytes. Position attachment builds one u32 compressed-byte offset per posting. Candidate-local reusable buffers decode only the needed occurrence streams. An unattached frequency list has no retained position bytes or positional-offset array.

### Object layout and embedding

Objects are named `<generation>/frequencies-N.bin`, `<generation>/positions-N.bin` and `<generation>/metadata-N.bin`. Each kind is packed independently toward the configured object-size target without splitting a single term stream/document. No per-term tiny objects are created. Both posting kinds share the bundle's local byte area, with explicit offsets in each descriptor.

The builder applies smallest-first or workload-aware selection to frequency streams first. After that, positions for selected frequency terms are eligible for remaining bundle space, using the same strategy on positional lengths. This frequency-first policy favors term-only zero-R2 queries. It may leave positions remote even when frequency lists are local; positional queries can then require additional ranged requests. Budget accounting includes the larger dictionary and both embedded stream kinds. Manifest statistics report frequency/position bytes and embedding separately.

Query jobs share one concurrency-four scheduler. Plain Boolean queries request only frequencies. Phrase/proximity queries add positions only for terms whose locations their expression consumes; unrelated Boolean filters and negations do not automatically request positions. The dictionary fully specifies both kinds. Token counting, field boundaries, stop-word handling, phrase/proximity semantics and BM25 are unchanged.

Generation-scoped R2 object metadata must match the bundle. Manifest SHA-256 and lengths protect complete files during deployment. Stream CRCs protect every local/remote payload; the position header binds it to the exact frequency bytes. Document blocks retain their CRCs. These integrity checks do not authenticate against a malicious storage writer; arbitrary header/directory/metadata changes are not all caught by runtime CRCs. Verify the complete generation before deployment.

## Compatibility

Version 5 rejects v1/v2/v3/v4 bundles; rebuild the complete block-stream generation and deploy the v5 Worker and bundle together. The generation hash includes the format version, preventing reuse of older object prefixes. Rollback requires the matching older Worker and binary.

A reader rejects unknown magic/version, inconsistent total length/section geometry, and malformed payloads. No automatic migration or fallback to another generation. Any format change requires a version bump and full rebuild. Tokenization/scoring changes must also update the builder's format/config generation hash to prevent reusing old generations.

## V5 block-based postings and skip pointers

Terms with `df <= 256` retain the small-list frequency/position encodings above, including whole-stream CRCs. For `df > 256`, the frequency payload begins with a directory: 16-byte header (`u32 magic 0x354b4c42`, df, block size 256, block count), followed by `ceil(df/256)` entries of 36 bytes. Each entry has nine u32 values: first doc ID, last doc ID, frequency offset, frequency length, frequency CRC32, position offset, position length, position CRC32, document count. Offsets are relative to the corresponding term stream. The dictionary frequency CRC covers this directory. The dictionary position CRC remains a build/whole-stream integrity value; query reads use directory block CRCs. Directory geometry, contiguous offsets, counts, and ordered disjoint doc ranges are checked before use.

Frequency block payloads follow the directory and each use the small-list frequency encoding, restarting doc gaps from zero (the first doc is absolute). The position stream concatenates matching small-list position blocks; each binds to its frequency block CRC. Each last block may contain fewer than 256 documents. This permits selected blocks to be independently read and validated. Corruption of skipped block payloads is detected when those blocks are read, rather than by scanning an entire term on every query.

The term dictionary still fully specifies objects/ranges locally. A remote block directory is read as a prefix range of that term's frequency payload, not a remote term lookup. Its size is computable from df. Full scans read it together with payload in one range. Sparse plans fetch it before choosing ranges. All directory bytes count toward index storage and, when local, the configured bundle budget. No per-block R2 objects are created.

The planner derives terms obligatory for every result (AND/proximity unions, OR intersection, left side of exclusion, no required term under NOT). If one term is more than eight times rarer than a large peer, it is decoded first as an anchor. Longer lists seek the anchor's sorted IDs against block endpoints, skipping nonoverlapping ranges. To limit R2 requests, fragmented selections are read through at most four contiguous windows per term stream, but only selected blocks are decoded/checksummed. This may transfer intervening unneeded bytes. All reads share one four-request concurrency bound. General OR/NOT expressions with no obligatory anchor retain exhaustive exact evaluation. Exact totals and BM25 scores are preserved.

## v6–v8 extensions (current writer: v8)

The current Worker reads complete v5, v6, v7 and v8 generations; it never mixes
objects across generations. The production builder now writes v8. Rebuild to
adopt the new encodings. The header, term descriptors and compressed document
sections retain their layouts; the header version identifies the blocked layout.

For v6 onward, lists over 256 documents have a 16-byte directory header with magic
`0x364b4c42` and 52-byte entries. The first 36 bytes retain the v5 geometry and
checksums. Bytes 36 and 44 hold little-endian f64 body/title BM25 maxima, without
title boosting. They are computed offline using the exact serving arithmetic,
corpus statistics and term df. The directory CRC covers the impacts. Independently
maximized fields remain conservative for every supported field/boost combination.
Every extra directory byte consumes the configured bundle budget.

V7 adds optional seekable positional blocks: u32 magic `0x37534f50`, u32 row count,
u32 bound frequency-block CRC, then one canonical u32 varint byte length per row,
then the original concatenated positional gap bytes. The block CRC covers all
bytes; lengths must exactly partition the payload. Loading verifies CRC, geometry,
frequency binding and row lengths. Canonical positional gaps, ordering, overflow
and exact row exhaustion are checked when that row is accessed. Skipped rows are
not semantically decoded. The decoder retains one u32 end per block, reusing the
existing per-row start offsets. This avoids a second full document-sized array.
The builder uses this encoding only when a block averages more than four positions
per row; sparse positional blocks keep the smaller legacy encoding.

V8 adds optional packed frequency blocks: u32 magic `0x38465250`, u32 row count,
u32 first document ID, followed by three column encodings (document gaps, body tf,
title tf). Each column starts with a byte: 0–32 means that many little-endian bits
per value; 64 means one constant u32. The first gap is ignored because the first
document ID is in the header; subsequent gaps must be positive. Constant document
gaps represent arithmetic runs without storing individual IDs. Constant frequency
columns use typed-array fills. Decoders check bounds, ordering, overflow, nonempty
frequencies, exact byte exhaustion and directory endpoints. The encoder picks the
smaller of packed and canonical-varint blocks, including all headers; v5 frequency
blocks and positional blocks remain valid within the extended directory.

## Paged root v1 (optional layout)

`bundle.bin` may instead start with little-endian magic `0x31504752`, followed by
u32 payload length, u32 CRC32, and a UTF-8 JSON routing payload. This small routing
payload is capped at 8 MiB; it contains corpus statistics, a 64-hex generation,
first-term/page-boundary descriptors and page offsets/lengths/CRCs. It contains no
complete term vocabulary or per-document records. Root version is 1; backing
posting/dictionary format remains v8. `openIndex` distinguishes both layouts.

`dictionary-0.bin` packs independent 256-term binary dictionary pages (existing
v8 header + descriptors + term strings, empty document table, all postings
remote). `norms-0.bin` packs 4096-document pages of exact little-endian u32 body
and title lengths (8 bytes per document). `documents-0.bin` packs independent
4096-document DTC2 tables containing external IDs and metadata pointers. The last
page of each section can be partial. Page payloads are addressed by root ranges;
CRCs are verified before cache insertion. All objects use the root generation
prefix and the normal R2 custom-metadata generation check. Upload manifests
include object SHA256 and root SHA256. Source postings are copied unchanged under
the new generation, and formerly embedded streams are moved into packed objects.

The converter is deterministic for a source generation. Direct paged builds use
an offline staging generation with no embedded postings, permitting dictionaries
larger than the serving bundle budget; this intermediate is never deployed.

## Hybrid paged root v2

Magic `0x32504752` selects a 28-byte little-endian header: magic, routing JSON
length, routing CRC32, local norm length, norm CRC32, compact ID length, ID CRC32.
Sections follow in that order: routing JSON, norms, IDs. The routing schema and
remote object layout remain the same as v1; `version` is 2. Norms are exactly
`documentCount * 8` bytes of u32 body/title lengths. IDs use magic `0x31534449`,
u32 document count, u32 restart size (32), u32 block count, `blocks+1` absolute
u32 offsets, then independently front-coded blocks. Each ID stores varint UTF-8
prefix length, varint suffix byte length, and suffix bytes. The root's ID-section
CRC covers both offsets and payload. Decoder access requires at most 32 ID
reconstructions and does not materialize a full string array at startup.

The routing JSON stays capped at 8 MiB. The total hybrid bundle is capped at the
configured builder budget (default 8 MiB, maximum 48 MiB), including both local
tables. A v2 root requires both tables, and v1 readers remain supported. Metadata
pointer records are fetched only when metadata is requested. The new generation
hash distinguishes v2 from v1, preserving immutable object and cache identities.

## Optimized paged root v3

Magic `0x33504752` selects a 36-byte header. The first 28 bytes follow v2;
u32 hot-index length and CRC32 are appended. The hot binary index follows the
routing JSON, exact norms and compact IDs. It uses the existing v8 dictionary
and posting codecs, with empty document records and optional embedded streams.
Its generation must match the routing root. The routing field `optimizationStep`
selects planning defaults; competitive positional execution remains an explicit
query option. v1 and v2 roots remain supported.

Cold R2 dictionary pages can also contain embedded streams. `LOCAL` offsets in a
hot descriptor refer to the bundled hot index, while offsets in a cold descriptor
refer to the fetched dictionary page that owns that descriptor. Each entire cold
page is verified by its root CRC; frequency/position codecs retain their existing
integrity checks. No separate remote dictionary request is needed after a term's
page is loaded. Full bundle budgeting includes every binary section.

## Snapshot statistics and passage sidecars

Routing v1 roots may include `stats: {count, bodyTokens, titleTokens, df}`. Token
totals sum each partition's rounded `count * average`, matching the serving stats
API. `df` contains exact global frequencies for every root `hot` term; other
frequencies come from the complete route pages. `ROUTE_SNAPSHOT` is a deployment
contract pinning router membership to the root generation. A live mutable router
must not opt into it.

Cards may contain `passages: [object, offset, compressedLength, crc32]`. This points
to a gzip-compressed directory in the card generation's `cards-N.bin` packs.
`passageroot-0.bin` has the same checked card-root layout as `cardroot-0.bin`, under
the index generation. It permits an immutable passage upgrade of an existing
index without replacing its original cards. The reader derives the passage
object generation from the root rather than accepting an external pointer.

A decompressed passage directory starts with little-endian u32 magic `0x31534750`
and u32 frame count. Each 1048-byte frame record contains six little-endian u32s
(object, offset, compressed length, compressed CRC32, core start within frame,
core length), followed by a 1024-byte Bloom filter. Frames are gzip UTF-8 strings
with up to 160/240 UTF-16 units of surrounding context. Core boundaries fall
between original text tokens, targeting 8192 UTF-16 units. Filters include every
term produced by the engine's tokenizer for each core token. Four bits use
`(FNV32(term) + i * ((FNV32(term) >>> 16) | 1)) & 8191`, i=0..3. Possible matches
are verified against decoded text. Directories and frames enforce a 4-MiB
expansion cap and check compressed CRCs and object generation metadata.

## Global retrieval format GLB1

This independent experimental format lives in `src/global/format.ts`; it is not
a new version of the BWS/paged index above.

The bundled header contains five little-endian u32s: magic `0x31424c47` (`GLB1`),
metadata byte length, hot dictionary byte length, metadata CRC32, hot dictionary
CRC32. The metadata is a small UTF-8 JSON root with version 1, corpus generation,
document count, average title/body lengths, physical page size, lexical dictionary
page ranges, and immutable pack names/sizes/SHA-256 hashes. The following binary
hot dictionary contains selected term plans. Header/metadata/hot lengths and CRCs
are validated before search.

Dictionaries front-code UTF-16 common-prefix lengths and UTF-8 suffixes, restarting
every 16 terms. UTF-16 prefixes never split surrogate pairs. A binary restart
offset table supports exact lookup without expanding the vocabulary into objects.
Each term's binary plan holds DF, block descriptors, optional complete inline
frequency/position rows, ranked seed rows, the maximum omitted seed score and
minimum omitted document ID, and optional 64-document-cell score maxima.

An address is five unsigned varints: object number, byte offset, compressed byte
length, CRC32 of compressed bytes, and uncompressed byte length. Payloads use gzip;
records are at most 8 MiB uncompressed. Ordinary records fit within a physical
page; large dictionary plans may span pages. Packs are at most 64 MiB and padded
to the configured 64/128/256-KiB alignment. R2 keys are
`{generation}/plan-{object}.bin`. CRCs and expansion lengths apply identically to
local, Cache API, CDN and R2 data. R2 objects additionally carry matching generation
metadata. The source corpus and exact root bundle are SHA-256 checked on build/
publish; CRCs detect accidental payload corruption, not malicious modifications.

Frequency rows use row version 1: count, delta document ID, UTF-8 external ID,
body/title TF, float64 little-endian body/title BM25 contribution, result address,
first body-passage address and first body position. Version 3 appends optional
inline UTF-8 display JSON and excerpt strings to each row. Position rows use
version 2: count, delta document IDs, body/title delta-position arrays, and a list
of token-chunk ID/address pairs. The decoder can skip allocation for unselected
documents. Frequency-only queries do not request position streams. Each block has
first/last document, count (at most 128), source tile, separate field score maxima,
and independent frequency/position addresses.

Display records contain external ID, title, metadata and preview. Passage records
contain normalized display text, first token and relative token start/end offsets,
covering 512 core tokens with 24-token overlap. Text remains case preserving;
token lookup uses the shared NFKC/lowercase Unicode tokenization. Exact positional
matches address the first and last required passage directly. Plain conjunctions
use the first matching term's location for the excerpt rather than claiming to
find a globally best multi-term passage.

Read groups can be larger than physical pages. Shared-cache page IDs encode group
size as `(log2(pageBytes)-16)*2^40 + object*objectPages + page`; this prevents cache
collisions between 64-, 128- and 256-KiB grouping. Cache entries are complete 200
responses, never 206 responses. Optional HTTP page objects use
`{generation}/page-{pageId}.bin`. A custom domain/CDN is separate from R2 bindings.
