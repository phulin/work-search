# Ingestion and codec investigation — 2026-11-12

**Gzip is a material ingestion cost. Zstandard level 1 is a modest complete-build
improvement, not another 2×.** On real serialized passage payloads it encodes
1.82× faster than libdeflate gzip level 1. Complete 100k builds use about 13.5%
less CPU, with an observed 6% reduction in median wall time and 0.83% more total
index bytes. Wall time is noisy on this shared machine; treat that ratio as a
screening result rather than a deployment forecast.

LZ4 with a tiny WASM decoder is another serving candidate. It trades substantially
larger text and fixed decoder memory for faster decoding. No production format or
builder default was changed. The candidate indexes are explicitly marked
`CWS1-CODEC-EXPERIMENT` and cannot be read as normal CWS1 without a benchmark adapter.

## Where ingestion spends time

A complete 100k gzip build was instrumented around the actual source functions,
including serialization, compression, packing and file writes. It took 20.30 s;
ingestion was 9.87 s. Its generation matches the uninstrumented production builder
exactly. The 71 ingestion tasks accumulated 75.89 s of worker elapsed time.
These nested-free categories sum work across concurrent workers and include
preemption and I/O waits: **they are not CPU samples or additive critical-path
wall times**.

| Ingestion operation                                              | Summed worker seconds | Share of summed worker elapsed |
| :--------------------------------------------------------------- | --------------------: | -----------------------------: |
| Gzip encoding, including output-buffer preparation               |                 28.41 |                          37.4% |
| Token normalization, lowercase, word scanning and offset mapping |                 13.37 |                          17.6% |
| Local term interning                                             |                  7.53 |                           9.9% |
| Run file writes, hashes and external-ID sorting                  |                  7.00 |                           9.2% |
| Position grouping / integer packing                              |                  4.63 |                           6.1% |
| Passage/display JSON serialization                               |                  4.31 |                           5.7% |
| Text pack writes, SHA and page CRC                               |                  2.68 |                           3.5% |
| Vocabulary sorting / row scatter                                 |                  2.53 |                           3.3% |
| Source JSON parsing                                              |                  1.20 |                           1.6% |
| Residual preparation, allocation, cleanup and instrumentation    |                  4.24 |                           5.6% |

This locates the cost more accurately than attributing all of the old combined
text phase to gzip. Parsing is small. Tokenization and interning together are
another 27.5%; removing compression does not remove that work, run publication,
or the final posting merge. [Raw profile](results/ingest-profile-100k.json).

There are 791,343 passage records and 100,000 display records. Before compression,
passages contain 3,474,487,847 bytes and displays 73,467,590 bytes. The payload is
unchanged JSON, including exact text, UTF-16 starts/ends and metadata. Numeric
posting streams already use integer packing and are unaffected by these codecs.

## Native encoding and size

Sample every 64th serialized text record, with the offset varied by fixed source
run ordinal. This yields **12,376 passages and 1,554 displays**, distributed across
the complete corpus, independent of query strings. Each codec is reused across
records, with reusable output buffers; the native benchmark includes copying each
encoded output for later decoding/verification. Three passes alternate codec order.
Every decoded payload is checked byte for byte.

| Passage codec                  | Median encode + copy, ms | Encoding speed vs gzip | Bytes vs gzip |
| :----------------------------- | -----------------------: | ---------------------: | ------------: |
| libdeflate gzip level 1        |                   254.97 |                  1.00× |        1.000× |
| libdeflate raw DEFLATE level 1 |                   254.23 |                  1.00× |        0.992× |
| Zstandard level 1              |                   140.42 |                  1.82× |        1.030× |
| Zstandard fast 1 (level -1)    |                    81.23 |                  3.14× |        1.647× |
| Zstandard fast 3 (level -3)    |                    54.26 |                  4.70× |        1.737× |
| LZ4 acceleration 1             |                    92.48 |                  2.76× |        1.593× |
| Brotli quality 0               |                   201.25 |                  1.27× |        1.092× |
| Uncompressed                   |                     3.50 |                  72.9× |        1.932× |

Removing the gzip wrapper alone barely changes encoding time. Brotli quality 0
loses on both size and speed to Zstandard level 1 for these payloads. The fastest
Zstandard modes save CPU but enlarge small independent records substantially.
Native versions: libdeflater 1.26.1, zstd 1.5.7, LZ4 1.10.0. Raw samples, all
repetitions and display-class results: [native codecs](results/native-codecs.json),
[summary](results/summary.json), [fixture identities](results/fixtures.json).
No dictionary or query-selected accelerator is used.

## Complete-build screening

Same corpus, eight threads, 16 MiB batches, identical builder snapshot except for
text codec and diagnostic timers. Three runs per codec, sequentially reversing
codec order each round. Complete parsing, tokenization, text, forward blocks,
sorting, scoring, checksums and publication are included; compilation/cleanup are
excluded. The gzip output is byte-identical to production generation
`c15c994fdac215e44e9b8df049826d1a65a2a5f3b890af8ec6aa34ffa7941c09`.

| Codec             | Complete wall median (range), s | User + system CPU median, s | Ingestion median, s | Total index bytes |
| :---------------- | ------------------------------: | --------------------------: | ------------------: | ----------------: |
| Gzip level 1      |             15.94 (15.53–17.46) |                       66.15 |                9.37 |     6,813,713,369 |
| Zstandard level 1 |             14.98 (12.65–17.28) |                       57.25 |                7.94 |     6,870,265,679 |
| Zstandard fast 3  |             17.38 (12.42–18.33) |                       52.03 |                8.48 |     8,174,340,251 |

Zstandard level 1 saves about 8.9 CPU-seconds per build. Its text is 3% larger,
but the whole index grows only 0.83%. The fast-3 index grows about 20%; extra
hashing/writes/page footprint offset much of the codec gain. Maximum individual
process RSS medians are 2,304 / 2,223 / 1,946 MiB respectively; variation in task
scheduling makes these insufficient to attribute a memory saving to a codec.
[Raw screening session](results/complete-100k.json).

Caveats matter. OS caches, SSD writeback and other host work were uncontrolled;
times drifted downward during the session. One round-0 Zstandard build overlapped
an approximately six-second local decoder diagnostic. CPU measurements were much
more stable than wall time. A planned five-round confirmation encountered a main
thread native corpus build competing for CPU and SSD; its completed gzip runs
were 46.70 / 59.37 s and Zstandard runs 28.72 / 33.33 s. This session was stopped
after four builds to avoid competing further. It is preserved separately and
**not pooled or used for an additional speedup claim**.
[Contended session](results/contended-100k.json). The incomplete fifth build was
excluded and its scratch reclaimed. No main-thread process or files were changed.

These samples cannot establish tight uncertainty or tail behavior. No 1M native
codec build, live Worker serving result, or claim about opaque R2 caches is made.

## Worker decoding changes the choice

The installed November 10 workerd was tested locally through Miniflare. Each
request decodes and JSON-parses a corpus-distributed batch of 128 records sixteen
times: 2,048 operations. One warmup then five alternating-order measurements per
codec/class. The client measures the complete local request and verifies a SHA-256
of all decoded bytes on the first iteration. This validation checksum is confined
to the benchmark, not the production search path. Payload transport, local dispatch,
allocation and JSON parsing are included. These are **local batched diagnostics,
not live Worker CPU or complete search-response latency**.

| Decoder                                               | Passage batch median, ms | Display batch median, ms |
| :---------------------------------------------------- | -----------------------: | -----------------------: |
| Existing gzip Response / DecompressionStream pipeline |                    85.17 |                    53.38 |
| Native `gunzipSync`                                   |                    42.76 |                    11.81 |
| Zstandard default sync path (fails some valid sizes)  |                    27.60 |                     8.43 |
| Zstandard `info: true` alternate path                 |                    33.32 |                    23.78 |
| LZ4, straightforward JS decoder                       |                   147.47 |                    15.69 |
| LZ4, 1,061-byte WASM decoder                          |                    23.44 |                     4.45 |
| Uncompressed JSON                                     |                    14.55 |                     3.28 |

The WASM decoder uses an 18 MiB fixed linear memory, including bounded input/output
buffers; this must count against Worker headroom. The binary is small, but memory
is not free. LZ4 passage bytes are about 59% larger than gzip. A full LZ4 index
was not built, so its aggregate page footprint/build benefit is unmeasured. A
WASM decoder avoids falsely rejecting LZ4 based on a slow JS implementation.

The default `zstdDecompressSync` rejects valid frames with decoded lengths 40,960,
81,920 and 163,840 bytes in this workerd build. Adjusting `chunkSize` and a tight
`maxOutputLength` did not fix it. The documented `info: true` path returns correct
bytes for all nine tested neighboring/boundary sizes, rejects four truncations,
and matches every one of the 13,930 real sampled payloads. The WASM LZ4 decoder
also matches every sampled payload in both Node and workerd. See the upstream
[workerd issue](https://github.com/cloudflare/workerd/issues/7923) for the default
path defect and alternate path. A flush-mode workaround was not adopted, since
it relaxes incomplete-frame detection. The safe alternate path loses much of the
default path's advantage, especially on small display records.

[Raw workerd results, runtime/source/binary hashes, validation and errors](results/workerd-decode.json).
The earlier local runtime and source changes were not substituted silently: the
final results pin the direct `workerd 2026-11-10` binary, compatibility date and
harness hash. Miniflare's nested July runtime was explicitly overridden for this
command only; shared packages and configuration remain untouched.

## Correctness and next action

The retained experimental Zstandard 100k index passes all 32 existing oracle
queries. Every result, score, title, metadata field and **full snippet** also
matches the final gzip native index byte for byte. [Verification](results/oracle-100k.json).
This uses an explicit Node benchmark adapter for the experimental format, not an
assumption that the existing deployed reader understands it.

1. Test native `gunzipSync` against the existing stream pipeline in live Workers.
   It preserves the format and avoids codec migration while improving the local
   decode baseline substantially.
2. Compare Zstandard level 1 with the validated alternate decoder, and LZ4 with
   bounded WASM memory, against that stronger gzip baseline. Include unfamiliar
   queries, physical page reads, cache footprint, memory and complete snippets.
3. Promote a codec only after that live comparison. Zstandard level 1 already has
   a measured offline CPU benefit; LZ4 has a stronger local decode result but a
   much larger footprint. Neither has demonstrated another 2× complete build.

The independent experiment tools and raw evidence are ready for integration;
production gzip remains the default. Remaining ingestion targets are tokenization /
interning and the text record representation itself, particularly textual numeric
start/end arrays, rather than treating all text-phase time as gzip.
