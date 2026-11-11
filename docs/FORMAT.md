# Binary format v2

All fixed integers are unsigned little-endian u32; offsets are bytes. Objects and individual sections must fit u32. The index file is at most the configured budget (up to 48 MiB). UTF-8 strings have no terminator. Dictionary order is JavaScript UTF-16 lexicographic order, not UTF-8 byte order. Readers/writers must use that comparator.

## Bundle

128-byte header:

| Offset | Value                                         |
| -----: | --------------------------------------------- |
|      0 | u32 magic 0x31535742 (`BWS1`)                 |
|      4 | u32 format version, 2                         |
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

Each term descriptor is 28 bytes: term-string offset relative to term strings, document frequency, object number (0xffffffff = bundled), posting offset, compressed length, CRC32, reserved zero. Term end is the next descriptor's string offset, or document-table start for the last term. Local posting offsets are relative to embedded-posting start; remote offsets are relative to an R2 object's beginning.

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

Body deltas and then title deltas follow, each in a separate byte-aligned bit-packed array. The width is `ceil(log2(max-min+1))`, or zero for constant values. Values start at consecutive `i*width` bit positions, with low-order bits stored first. Array byte length is `ceil(count*width/8)`. Adding a document's packed delta to its field minimum yields its exact u32 length. Length reads use the directory directly; they do not scan IDs or expand the document table. Constant-length blocks store only the two minima.

Variable-length records follow the packed lengths, one per document:

1. Varint common UTF-8 byte-prefix length against the previous ID within this block (zero for the first ID).
2. Varint suffix byte length, then the suffix bytes.
3. Varint metadata pointer tag: `0` uses the current object/offset; `1` is followed by absolute varint object and offset. Other tags are invalid.
4. Varint metadata length. The next current offset becomes this record's offset plus length.

Prefix comparisons may split a multibyte character; only the fully reconstructed ID is decoded as UTF-8. This preserves arbitrary valid Unicode IDs without sorting or changing internal IDs. A zero metadata tag captures contiguous records; exceptions handle object transitions, gaps and nonmonotonic locations. The block header provides a full restart for both IDs and pointers. Random document retrieval scans at most 32 records, and only top-K winners need IDs during ranking. Remote metadata ranges still hold individual JSON objects `{id,title?,metadata?}`.

The directory and block geometry are checked before accessing a block. Each block's CRC covers its header, packed lengths, IDs and pointers; validation is lazy and remembered in one bit per block (3,907 bytes at one million documents). No document arrays or ID maps are built during Worker startup. Bundle bytes must remain immutable after construction. Corrupt widths, overflowing values, invalid prefixes/pointer tags, truncated records and trailing bytes at a block's end are rejected.

## Postings

Unsigned LEB128 canonical varints (maximum 5 bytes / u32). Each list: document frequency followed by `(document gap, body TF, title TF)` for every document. First gap is the first internal ID (so it may be zero). Later gaps must be positive. At least one TF is positive. No positions. Decoder rejects trailing data, invalid frequency, malformed/truncated integers, and unordered IDs. Runtime also checks document bounds. Empty lists encode as a single zero byte, although no dictionary term points to one.

Objects are named `<generation>/postings-<number>.bin` and `<generation>/metadata-<number>.bin`. Packing aims for 64 MiB without splitting a single list/document. No remote dictionary exists. Remote object custom metadata `generation` must match the header. Manifest SHA-256 and lengths protect complete files during deployment; per-list CRC32 protects every local/remote posting retrieval. Document blocks also have CRC32 protection. Header, directory and remote metadata arbitrary bit flips are not all detected by runtime CRCs; verify the complete generation before deployment. This format is not authenticated against hostile storage modifications.

## Compatibility

Version 2 intentionally rejects v1 bundles; rebuild the complete generation and deploy the v2 Worker and bundle together. The generation hash includes the format version, preventing reuse of v1 object prefixes. Rollback requires the matching older Worker and binary.

A reader rejects unknown magic/version, inconsistent total length/section geometry, and malformed payloads. No automatic migration or fallback to another generation. Any format change requires a version bump and full rebuild. Tokenization/scoring changes must also update the builder's format/config generation hash to prevent reusing old generations.
