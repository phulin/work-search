# Native builder measurements — 2026-11-12

The final builder completes the pinned real 100k corpus in **21.48 s median**
(19.23–26.25 s, N=3), using eight threads and 16 MiB batches. At the identical
settings the frozen previous optimized builder takes **23.17 s** (21.55–23.55 s,
N=3): **7.3% less wall time**, or a 1.08× ratio of medians. This last pass is an
incremental improvement, not another demonstrated 2× code-only gain.

These are complete offline build times, not Worker search latency measurements.
The build includes source parsing, tokenization, text/passages, positions, sorting,
scoring, forward blocks, checksums and publication. Compilation and benchmark
cleanup are excluded. No output component was omitted.

## Latest matched comparisons

Sequential builds, alternating variant order each round, on an Apple M3 shared
macOS laptop. The control is commit `f1ef66fed67a2f829aa1bba8fccc34151e6da739`
(`codex/rust-builder-v2-control`). Each row has three builds per variant.

| Documents | Threads / batch MiB | Previous optimized median (range), s | Final median (range), s |
| --------: | ------------------: | -----------------------------------: | ----------------------: |
|     1,000 |               4 / 4 |                  0.346 (0.338–0.356) |     0.300 (0.296–0.345) |
|    10,000 |               4 / 4 |                  2.527 (2.385–2.910) |     2.538 (2.192–2.540) |
|   100,000 |              8 / 16 |               23.167 (21.548–23.550) |  21.484 (19.226–26.248) |

Raw data: [100k](results/latest-100k.json), [small](results/latest-small.json),
[summary](results/summary.json). The 10k median is effectively unchanged (+0.4%),
with reduced merge time offset by ingest variation. Three repetitions cannot
establish narrow uncertainty or tail percentiles. Filesystem caches, writeback,
and competing activity were uncontrolled. Another main-project build/upload was
active on the same SSD; individual sessions varied substantially.

At 100k the latest median individual-process peak RSS is 2,227 MiB, versus
2,092 MiB for the matched control. Median user+system CPU is 75.95 s versus
74.55 s: the pipeline improves overlap rather than demonstrating less total CPU.
The process-tree RSS samples in the raw results are sums sampled every 100 ms,
not exact simultaneous peaks. None of these measurements describe retained Worker
memory or cumulative allocations.

## What changed in the last pass

Checkpoint creation now reuses immutable pack digests and hashes temporary files
as they are written, below a 1 MiB buffer. It no longer rereads those files merely
to produce their first checksum. Resume still rehashes and validates artifacts;
corrupt pack and posting tests confirm that validation remains active.

Posting merge/scoring/encoding now runs in one producer while the consumer builds
bounds, hashes and writes output. Two bounded 32-block channels transfer and
recycle column buffers. Output order, physical bytes and generation are unchanged
at the same batch size; no extra posting spill or output patch pass is introduced.
The final read buffers remain 256 KiB per merge cursor.

Batch/thread tuning is a separate gain. The older four-thread / 4 MiB optimized
configuration measured 43.34 s in its three-round session, and 44.49 s in its
final-publication confirmation. The same code with eight threads / 16 MiB takes
23.17 s in the latest session. Larger batches reduce 280 input runs to 71 and
626 output objects to 208. **The roughly 44 → 21 s change combines settings,
code and session conditions; it is not a matched 2× algorithm claim.** Keep 4 MiB
as the default for small corpora; use explicit eight-thread / 16 MiB settings for
this large-corpus workload when about 2–2.5 GiB of RSS is acceptable.

## Profiling and rejected experiments

A native `sample` capture of the frozen optimized control at four threads / 4 MiB
found ingest active stacks dominated by libdeflate work, with tokenization,
normalization and interning also visible. In the merge capture, about 57% of
main-thread samples were in `read` and about 12% in accelerated SHA-256. These
are sampled stacks including I/O waits, not precise CPU percentages.
[Ingest capture](profiles/ingest.sample.txt), [merge capture](profiles/merge.sample.txt),
[provenance](profiles/provenance.json). The profiled build is excluded from the
finalist table. Profiling motivated avoiding file rereads and overlapping output.

A larger read-buffer pool of up to 512 MiB did not provide a repeatable merge
improvement. It was removed. A paired session combining this buffer experiment
with pack-digest reuse measured 24.02 → 21.98 s, but merge medians were
8.74 → 8.85 s; forward encoding was 1.77 → 0.68 s. That evidence supported
retaining digest reuse rather than the larger buffers.
[Raw comparison](results/buffer-and-pack-digest-100k.json),
[initial buffer pilot](results/buffer-pilot-100k.json).

With normal buffers restored, a two-round pipeline session under heavier I/O load
measured control runs of 47.53 / 42.73 s and pipeline runs of 37.22 / 38.94 s.
This is supporting evidence for overlapping work, not pooled into the quieter
finalist statistics. [Raw session](results/pipeline-100k.json).

Single-run batch pilots measured 33.58 s at four threads / 16 MiB, 30.54 s at
eight threads / 16 MiB, and 49.17 s at four threads / 32 MiB. Conditions varied;
these pilots selected finalists rather than proving causal ratios. The 32 MiB
setting was rejected. [4/16](results/batch16-threads4-pilot-100k.json),
[8/16](results/batch16-threads8-pilot-100k.json),
[4/32](results/batch32-threads4-pilot-100k.json).

Current final median stage times at 100k are ingest **12.46 s**, vocabulary/ID
validation **2.08 s**, forward encoding **0.59 s**, publication **0.08 s**, and
merge/emission **6.32 s**. Stage medians need not sum to the median total.
Parsing/tokenization/text compression now occupy about 58% of elapsed time, and
merge/output about 29%. Those are the remaining targets. Changing the text codec
could help, but requires a matching serving decoder and a live serving comparison;
it is not justified by offline compression time alone. SHA-256 is offline build /
checkpoint / publication work; the replacement Worker reads page CRC32 and does
not compute SHA-256 during search.

## Earlier matched gains

Before this last pass, the native builder replaced V8 scoring with float64 native
BM25, fused scoring into the final merge, adopted immutable text/token packs by
hardlink, used linear counting scatter and reusable packing/compression buffers,
and enabled hardware SHA dispatch. A first-Rust control with V8 scoring is frozen
at `8e66d77743b326662dbdc608593e3cca8860e29c`
(`codex/rust-builder-v1-control`). With identical four-thread / 4 MiB settings:

| Documents | First Rust median (range), s | Optimized median (range), s | Median speedup |
| --------: | ---------------------------: | --------------------------: | -------------: |
|     1,000 |          1.015 (0.930–1.110) |         0.333 (0.318–0.340) |          3.05× |
|    10,000 |          7.350 (7.169–8.263) |         2.767 (2.539–3.356) |          2.66× |
|   100,000 |      97.641 (89.389–109.091) |      43.345 (42.309–53.452) |          2.25× |

[Small results](results/final-small.json), [100k](results/final-100k.json).
The exact measured source is preserved at
`58a850144967669a0fa843bf389ae9b8ecc96ce0`
(`codex/rust-builder-measured-v2`). A subsequent root-publication ordering fix was
confirmed separately at 44.49 s, N=1, identical generation:
[confirmation](results/final-publication-check-100k.json).

An earlier direct TS/first-Rust 10k session measured 84.31 s versus 7.45 s
medians (three each), or 11.32×. [Raw session](results/typescript-vs-first-rust-10k.json).
Do not multiply these independent sessions into a contemporary TS/final speedup.
A historical TS 100k result is excluded because its source changed during launch.

## Correctness and adoption

Latest 100k output: 6,813,713,369 bytes, 632,909 terms, 187,425,411 body tokens,
556,941 title tokens. Both latest variants have byte-identical content-derived
generation `c15c994fdac215e44e9b8df049826d1a65a2a5f3b890af8ec6aa34ffa7941c09`.
The input hash is
`e621b2654ab99a61b8f558dd912193002594de4086d8e1d560324637ef14fb06`.
The raw results pin binary, lockfile, source hashes, corpus and configuration.
Hardware: Apple M3 / macOS ARM64; Node 26.7.0 / Unicode 17.0; Rust 1.93.0.

`yarn test` passes **182 tests in 37 files**; five Rust unit tests, four native
integration tests, all Unicode checks, typechecking, formatting and clippy pass.
Tests compare every synthetic posting/frequency/position/score, forward streams,
object hashes, metadata, fields, Boolean/positional AST ranking, ties, pagination,
long and empty documents, duplicate IDs, corruption, resume, forced external merge,
thread-count determinism and streamed FIFO input. All 1,112,064 valid Unicode
scalars plus 1,000 random/context cases match tokenization and UTF-16 offsets.
Float64 scores retain the formula, with explicitly accepted approximate FP equality.
See [DESIGN.md](DESIGN.md) for Unicode input and extreme near-tie qualifications.

The final retained 100k index passes all 32 existing oracle queries: result IDs,
scores within relative 1e-11, title/metadata and nonempty snippets.
[Final verification](results/latest-oracle-100k.json). Local verification times
are diagnostics, not serving benchmarks.

**Recommendation:** merge this as the base CWS1 offline builder. Optional pair /
head / lane construction remains the main project's separate work. No native 1M /
largest-corpus build or live serving speedup is claimed. Those still require direct
measurements. The old streaming uploader assumes an earlier source-derived
generation, whereas native generation includes actual output content and layout;
use a matching generation-aware publisher rather than mixing its root and packs.

## Reproduction

Prepare the latest frozen control once, outside the production checkout:

```sh
git worktree add /tmp/work-search-builder-v2-control codex/rust-builder-v2-control
(cd /tmp/work-search-builder-v2-control && cargo build --release --locked)
mkdir -p work/rust-builder-v2-control
cp /tmp/work-search-builder-v2-control/target/release/work-search-builder work/rust-builder-v2-control/
cp /tmp/work-search-builder-v2-control/Cargo.lock work/rust-builder-v2-control/
yarn builder:compile
BUILDER_VARIANTS=rust-v2,rust BENCH_CLEAN=1 BENCH_KEEP_LAST_RUST=1 \
  yarn bench:builder /path/flp-100000/corpus.jsonl work/repeat-100k 100000 3 8 16
BUILDER_VARIANTS=rust-v2,rust BENCH_CLEAN=1 \
  yarn bench:builder /path/flp-100000/corpus.jsonl work/repeat-small 1000,10000 3 4 4
```

To reproduce first-Rust comparisons, prepare its frozen ref similarly, also copy
`crates/index-builder` to `work/rust-builder-v1-control/index-builder` for its
V8 scorer script, and select `BUILDER_VARIANTS=rust-v1,rust`.
See [README.md](README.md) for construction, FIFO input and verification commands.
Raw results/logs/roots/manifests are retained. Superseded large pack/staging trees
were reclaimed; one final 100k output remains in the isolated worktree for reuse.
