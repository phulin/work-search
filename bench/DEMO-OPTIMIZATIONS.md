# Sequential demo optimizations

Frozen corpus: 2,866,398 opinions, 67 partitions, unchanged 8-MiB bundled indexes.
The 16-query scenario suite and measured R2 header/body samples are described in
[the baseline report](DEMO-REALISTIC.md). Timed local execution uses real gateway
and shard handlers, with reset and three-pass repeated application caches. Each
response is checked against the frozen deployed rankings and legal case fields.
Numbers below are simulations, not new deployed latency measurements. P95 over
16 scenarios is the largest sample and does not establish a production SLO.

|Cumulative change, final warmed pass|Repeated-range P50 / P95|Varied-range P50 / P95|
|---|---:|---:|
|Baseline|1.48s / 3.73s|2.74s / 6.82s|
|1. Packed result cards and body pointers|0.86s / 3.08s|1.46s / 5.85s|

Stage 1 removes the separate leaf document/metadata lookup and the content-catalog
lookup for card-backed results. A bounded 4-MiB gateway cache retains directory
bytes and requested card records. Cached records need only an excerpt/body read.
Six per-hit pipelines avoid waiting for an entire metadata batch before starting
bodies. Cards have their own immutable object generation, checked IDs, CRCs and
decompression limits; their root publishes last. Older indexes without cards keep
the original path until backfill completes. Index bundles are byte-for-byte
unchanged. This uses no workload-selected phrase accelerator.

Stage 1: 128 timed responses verified; 145 automated tests pass. Raw compact
measurements are in [results/demo-opt-stage1.json](results/demo-opt-stage1.json).

Stage 2 restores lazy block search/WAND under global BM25 using conservative
per-field bounds scaled by the global/local IDF ratio and the maximum possible
average-length ratio. Search-after filtering preserves deterministic ordering.
Fully fetched frequency streams up to 256 KiB retain complete decoded lists;
larger lists continue lazy block reads. Bundled index bytes remain unchanged.

|Cumulative change, final warmed pass|Repeated-range P50 / P95|Varied-range P50 / P95|
|---|---:|---:|
|2. Global bounds and block skipping|0.87s / 3.08s|1.62s / 5.60s|

This is a mixed result: the varied-range tail improves about 4%, while its median
regresses about 11%. Phrase/proximity/negative trees retain the materialized
executor. All 128 simulated responses match baseline IDs, scores and case fields.
See [stage 2 measurements](results/demo-opt-stage2.json). These are cumulative
local simulations; timings include normal host noise.

Deployed validation of stage 1: two complete 16-query passes against the same
frozen 67-partition graph, with all rankings checked against the baseline.
The second pass measured gateway P50 / P95 **0.73s / 1.82s**, versus the earlier
baseline's final pass **1.61s / 3.32s**. This is not a randomized interleaved trial:
backend warmth, deployment timing and service placement can differ. The first
stage-1 pass was **1.64s / 3.53s**. Local simulation tables remain separate.

Deployed stage 2 validation (same frozen generations, all 32 rankings verified):
first pass **1.21s / 3.41s**, second pass **0.56s / 1.61s** gateway P50 / P95.
As with stage 1, these sequential native measurements have uncontrolled backend
warmth and placement. They support the change but do not override the mixed
result in the controlled local simulation. Compact native measurements are in
[results/demo-opt-live.json](results/demo-opt-live.json).

Stage 3 builds a **complete corpus-derived** global directory: 4096 hash buckets,
550,856,714 compressed bytes in nine R2 packs, and a **327,397-byte** bundled root.
The root fits inside the gateway's existing 8-MiB budget; all 67 partition bundles
remain byte-for-byte unchanged. Two 2-MiB caches retain pages and requested terms.
Common terms already hot in every positive partition keep their existing path.
Rare terms supply exact global DFs, presence and remote posting descriptors.
Inline descriptors still load their originating page. Only generation-matched
partitions use the directory; new partitions supply ordinary DFs and remain
eligible. Conservative AST checks never prune a potentially matching NOT branch.

|Cumulative change, final warmed pass|Repeated-range P50 / P95|Varied-range P50 / P95|
|---|---:|---:|
|3. Global directory and generation-safe routing|0.89s / 2.90s|1.56s / 5.78s|

Overall versus baseline: **40–43% lower P50**, **15–22% lower P95**, and **41% fewer
R2 reads**. Mean all-graph R2 requests fall from 137.25 to 80.81 / 80.31 per query
(repeated / varied). The only zero-read scenario is the warmed empty-result
control: 1/16 queries. Queries returning excerpts still read their opinion bodies.
Stage 3 is a mixed latency result versus stage 2: repeated P95 improves about 6%,
varied P50 improves about 4%, repeated P50 regresses about 2%, and varied P95
regresses about 3%. Cards account for most of the end-to-end gain; reduced read
counts alone do not establish a latency win.

Stage 3 deployed validation: first pass **1.15s / 2.78s**, second pass **0.61s /
1.70s** gateway P50 / P95. Relative to the original deployed final pass, that is
about **62% lower median and 49% lower P95**. It is slightly slower than stage 2's
second pass (0.56s / 1.61s); these non-interleaved small samples cannot establish
whether that difference persists under traffic. All 96 native stage-1/2/3 responses
match baseline rankings. The model likewise verifies all 384 staged responses,
including case fields, plus 12 timed first/second-page responses. The directory
has no query-frequency training or workload-selected phrase accelerator.

[Stage 3 measurements](results/demo-opt-stage3.json),
[summary including reset caches, CPU and memory](results/demo-opt-summary.json),
[native measurements](results/demo-opt-live.json), and
[pagination measurements](results/demo-opt-pages.json) are machine readable.
`r2Bytes` counts consumed bytes; `r2RequestedBytes` includes complete requested
ranges even when body reading stops early. Native R2 counts cover gateway I/O
only; local simulation counts the complete service graph.

Node CPU/RSS are all-process observations for 67 logical Workers on one event
loop, with the import continuing separately. They are not per-isolate Cloudflare
CPU or memory measurements. Final warmed CPU P50 is 249 / 226 ms (repeated /
varied), versus baseline 256 / 209 ms; this does **not** establish an overall CPU
improvement. Observed process RSS peaks are about 705 / 592 MiB. The directory
builder uses sorted per-partition segments and a bounded external merge, with
checksums and generation validation at its source. Downloads retry interruptions;
immutable packs upload before atomically replacing the bundled pointer.

Validation: **154 tests pass**, including actual workerd/R2/Data-module tests,
global-bound oracle comparisons, cold/warm cache equivalence, deterministic and
resumable directory builds, Unicode merging, descriptor hints, corruption, partial
coverage and pagination. Run `node --import tsx bench/demo-opt-report.ts` to
recompute the summary from the checked-in compact measurements.

The final gateway dry run is 398.78 KiB including its routing Data module
(109.41 KiB gzipped). Production enables level 3 and continues to accept newly
published partitions through the uncovered-generation fallback. The frozen
benchmark's directory covers 67 partitions, not all opinions added afterward.
Use the documented `--all` refresh to extend directory coverage without changing
the frozen benchmark snapshot. Public smoke checks verified legal fields,
nonduplicate second-page hits, empty results and hits from uncovered partitions.
