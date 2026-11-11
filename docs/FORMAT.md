# Binary format v4

All fixed integers are unsigned little-endian u32; offsets are bytes. Objects and individual sections must fit u32. The index file is at most the configured budget (up to 48 MiB). UTF-8 strings have no terminator. Dictionary order is JavaScript UTF-16 lexicographic order, not UTF-8 byte order. Readers/writers must use that comparator.

## Bundle

128-byte header:

| Offset | Value                                         |
| -----: | --------------------------------------------- |
|      0 | u32 magic 0x31535742 (`BWS1`)                 |
|      4 | u32 format version, 4                         |
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
|     20 | Frequency CRC32                                        |
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

All compressed integers use canonical unsigned LEB128 (maximum five bytes / u32). Frequencies and positions are separately encoded, checksummed, embedded and packed into immutable objects. The v3 interleaved codec remains only as a frozen-reference/test helper and is not used by the deployed v4 query path.

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

Version 4 rejects v1/v2/v3 bundles; rebuild the complete split-stream generation and deploy the v4 Worker and bundle together. The generation hash includes the format version, preventing reuse of older object prefixes. Rollback requires the matching older Worker and binary.

A reader rejects unknown magic/version, inconsistent total length/section geometry, and malformed payloads. No automatic migration or fallback to another generation. Any format change requires a version bump and full rebuild. Tokenization/scoring changes must also update the builder's format/config generation hash to prevent reusing old generations.
