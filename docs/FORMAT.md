# Binary format v1

All fixed integers are unsigned little-endian u32; offsets are bytes. Objects and individual sections must fit u32. The index file is at most the configured budget (up to 48 MiB). UTF-8 strings have no terminator. Dictionary order is JavaScript UTF-16 lexicographic order, not UTF-8 byte order. Readers/writers must use that comparator.

## Bundle

128-byte header:

| Offset | Value                                         |
| -----: | --------------------------------------------- |
|      0 | u32 magic 0x31535742 (`BWS1`)                 |
|      4 | u32 format version, 1                         |
|      8 | u32 total bundle byte length                  |
|     12 | u32 document count                            |
|     16 | u32 term count                                |
|     20 | reserved zero                                 |
|     24 | f64 average body length                       |
|     32 | f64 average title length                      |
|     40 | u32 dictionary-descriptor start, always 128   |
|     44 | u32 term-string start                         |
|     48 | u32 document-table start                      |
|     52 | u32 external-ID string start                  |
|     56 | u32 embedded-posting start                    |
|     60 | reserved zero                                 |
|     64 | 64 ASCII hex characters of generation SHA-256 |

Each term descriptor is 28 bytes: term-string offset relative to term strings, document frequency, object number (0xffffffff = bundled), posting offset, compressed length, CRC32, reserved zero. Term end is the next descriptor's string offset, or document-table start for the last term. Local posting offsets are relative to embedded-posting start; remote offsets are relative to an R2 object's beginning.

Each document descriptor is 24 bytes: external-ID string offset, body token count, title token count, metadata object number, metadata offset, metadata length. ID end is the next document's string offset, or embedded-posting start for the final document. Documents occur in internal ID order. Metadata object ranges hold one JSON object `{id,title?,metadata?}` each, concatenated without delimiters. Metadata identity and object generation are validated on retrieval.

## Postings

Unsigned LEB128 canonical varints (maximum 5 bytes / u32). Each list: document frequency followed by `(document gap, body TF, title TF)` for every document. First gap is the first internal ID (so it may be zero). Later gaps must be positive. At least one TF is positive. No positions. Decoder rejects trailing data, invalid frequency, malformed/truncated integers, and unordered IDs. Runtime also checks document bounds. Empty lists encode as a single zero byte, although no dictionary term points to one.

Objects are named `<generation>/postings-<number>.bin` and `<generation>/metadata-<number>.bin`. Packing aims for 64 MiB without splitting a single list/document. No remote dictionary exists. Remote object custom metadata `generation` must match the header. Manifest SHA-256 and lengths protect complete files during deployment; per-list CRC32 protects every local/remote posting retrieval. Header/ID/metadata arbitrary bit flips are not all detected by runtime CRCs; verify the complete generation before deployment. This format is not authenticated against hostile storage modifications.

## Compatibility

A reader rejects unknown magic/version, inconsistent total length/section geometry, and malformed payloads. No automatic migration or fallback to another generation. Any format change requires a version bump and full rebuild. Tokenization/scoring changes must also update the builder's format/config generation hash to prevent reusing old generations.
