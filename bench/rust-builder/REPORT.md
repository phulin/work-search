# Native builder results — 2026-11-12

The optimized builder meets the additional 2× goal on the pinned real 100k corpus:
**97.64 s → 43.34 s**, a **2.25× ratio of medians**, with the same four-thread,
4 MiB batch configuration. At 1k the complete build is now **0.333 s**.
These are offline build times, not Worker search latency measurements.

## Complete-build comparison

Three sequential builds per variant and corpus size, alternating variant order by
round. All runs include source parsing, tokenization, display/passage gzip,
positions, external sorting, scoring, forward blocks, checksums and publication.
Compilation and post-run cleanup are excluded. No output components were omitted.

| Documents | First Rust median (range), s | Final Rust median (range), s | Median speedup |
| --------: | ---------------------------: | ---------------------------: | -------------: |
|     1,000 |          1.015 (0.930–1.110) |          0.333 (0.318–0.340) |          3.05× |
|    10,000 |          7.350 (7.169–8.263) |          2.767 (2.539–3.356) |          2.66× |
|   100,000 |      97.641 (89.389–109.091) |       43.345 (42.309–53.452) |          2.25× |

After the matched sessions, the final publication ordering was tightened: the
completion checkpoint is committed before the atomic root rename. Encoding and
scoring are unchanged. A complete build of that final binary took **44.49 s**
(N=1), with the identical generation and another successful 32-query oracle check.
Its individual-process peak RSS was 726 MiB. This confirmation is kept separate
from the three-round statistics: [raw confirmation](results/final-publication-check-100k.json).
The exact source used in the matched three-round sessions is preserved at
`58a850144967669a0fa843bf389ae9b8ecc96ce0`
(`codex/rust-builder-measured-v2`); its source hash matches the recorded manifest.

Raw data: [small corpora](results/final-small.json),
[100k](results/final-100k.json), [summary](results/summary.json).
With only three repetitions, the ranges show substantial observed variability;
these are not confidence intervals or estimates of tail percentiles. This was a
shared development laptop, with other activity and uncontrolled filesystem caches.
The 100k result is measured directly; larger sizes must not be extrapolated from it.

An earlier matched, interleaved TS/first-Rust 10k session measured TS median
84.31 s (82.84–98.43), versus first Rust 7.45 s (6.48–7.74), or 11.32×.
[Raw session](results/typescript-vs-first-rust-10k.json). The final Rust/TS ratio
across those two sessions is approximately 30×, but that is **not a contemporary
interleaved TS/final-Rust comparison**. The primary additional-speedup claim uses
the direct Rust control comparisons above. A historical TS 100k build is excluded
because source changes during its launch make it an unreliable matched control.

## What removed the time

- Native float64 scoring removed the batched V8 subprocess and its intermediate
  serialization. The BM25 formula and float64 storage remain; last-bit equality
  with V8 was explicitly relaxed.
- The final merge scores raw postings and emits packed columns directly. The
  scored-postings rewrite/reread pass is gone. Cursor runs reduce heap operations.
- Immutable text/token objects are adopted through hardlinks on the same volume.
  Only directories containing references are relocated. Median 100k publication
  fell from 10.60 s to 0.27 s in the final comparison.
- Linear counting scatter replaced occurrence/posting comparison sorts. Small
  position blocks append into reusable buffers; leaf encoding reuses column
  buffers. Interning uses a fast local hash table. NFKC quick checks avoid
  normalizing already-normalized input through a slower path.
- Native libdeflate replaces repeated gzip setup. Posting columns use integer
  packing, with no gzip in postings execution.
- A three-second native sample of a tuning build found about 26% of main-thread
  samples in software SHA-256. ARM hardware dispatch removed that avoidable cost.
  That instrumented run and a run overlapping artifact deletion are excluded from
  the finalist table. SHA-256 remains offline object/generation/checkpoint tooling;
  the search Worker computes page CRC32, not SHA-256.

Final 100k median stage times: ingest 17.50 s, vocabulary/ID validation 4.24 s,
forward encoding 2.27 s, publication 0.27 s, merge/emission 20.00 s. Stage medians
need not sum to the median total. The serial final merge, output I/O, and parsing /
tokenization / passage compression remain the main optimization opportunities.
Checkpoint creation still rereads some already-hashed pack files; reusing
write-time digests is an unimplemented follow-up, not credited in these numbers.

## Footprint and correctness

Final 100k output: 6,813,453,638 bytes, versus 6,813,225,784 for the first Rust
control (+0.0033%). It contains 632,909 terms, 187,425,411 body tokens and 556,941
title tokens. Both builders pin the same corpus hash:
`e621b2654ab99a61b8f558dd912193002594de4086d8e1d560324637ef14fb06`.

Memory has a tradeoff. At 100k the median maximum individual-process RSS rose from
546 MiB to 668 MiB. Median sampled process-tree peak rose from 536 to 654 MiB.
At 10k the V8 child makes the process-tree comparison favor the final builder
(550 → 427 MiB), despite a higher individual-process RSS (358 → 426 MiB).
Process-tree RSS was sampled every 100 ms; it is not an exact peak. These metrics
are neither retained Worker memory nor cumulative allocation measurements.

Validation covers every synthetic posting, frequency, position, score within
strict tolerance, forward token stream, object hash, result metadata, Boolean and
positional AST ranking, fields, deterministic ties, pagination using each
engine's own generation-specific cursor, Unicode offsets, long documents,
zero-token documents, duplicate IDs, corruption, resume, and deterministic output
across worker counts. A low-file-descriptor test forces the external posting spill
path. All 1,112,064 valid Unicode scalars plus 1,000 random strings and contextual
cases match the existing tokenizer/offset implementation.

`yarn test` passed all 181 tests in 37 files; Rust unit tests, native integration
tests, typechecking, formatting and clippy also pass.

The retained final real 100k index passes all 32 existing query-oracle scenarios:
result IDs, float64 scores within relative 1e-11, title/metadata and nonempty
query-relevant snippets. [Machine verification](results/oracle-100k.json).
The report does not claim bit-for-bit cross-runtime FP equality. Lone-surrogate
JSON inputs and previews ending inside a surrogate pair have the limitations
listed in [DESIGN.md](DESIGN.md).

## Reproduction and adoption

Hardware: Apple M3, macOS ARM64. Node 26.7.0 / Unicode 17.0, Rust 1.93.0.
The machine-readable results pin release binary, Cargo lockfile and source hashes,
format, corpus, batch bytes, thread count, output identity and timings. Final 100k
generation: `9e863c9de344f0276a375aab109f16318055418358b8fbc89d28e2cc212859b3`.

The first Rust control is frozen separately at commit
`8e66d77743b326662dbdc608593e3cca8860e29c`
(`codex/rust-builder-v1-control`). To recreate its benchmark artifact:

```sh
git worktree add /tmp/work-search-builder-control codex/rust-builder-v1-control
(cd /tmp/work-search-builder-control && cargo build --release --locked)
mkdir -p work/rust-builder-v1-control
cp /tmp/work-search-builder-control/target/release/work-search-builder work/rust-builder-v1-control/
cp /tmp/work-search-builder-control/Cargo.lock work/rust-builder-v1-control/
cp -R /tmp/work-search-builder-control/crates/index-builder work/rust-builder-v1-control/index-builder
```

From the final branch, run `yarn builder:compile`, then:

```sh
BUILDER_VARIANTS=rust,rust-v1 BENCH_CLEAN=1 BENCH_KEEP_LAST_RUST=1 \
  yarn bench:builder /path/flp-100000/corpus.jsonl work/repeat-100k 100000 3 4
BUILDER_VARIANTS=rust-v1,rust BENCH_CLEAN=1 \
  yarn bench:builder /path/flp-100000/corpus.jsonl work/repeat-small 1000,10000 3 4
```

See [README.md](README.md) for build, test and verification commands. Completed
benchmark intermediates were reclaimed; raw results, logs, roots and manifests
were preserved. One final 100k output remains in the isolated worktree for reuse.

**Recommendation:** integrate this as the base CWS1 offline builder and route
production construction through it. Optional pair construction still belongs to
the main implementation. This is not a recommendation to adopt the entire query
engine for full-corpus serving: no 1M/largest-corpus native build or live serving
benchmark is claimed here. Those qualifications remain the main project's work.
