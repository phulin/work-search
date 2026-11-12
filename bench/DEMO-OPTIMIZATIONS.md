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
