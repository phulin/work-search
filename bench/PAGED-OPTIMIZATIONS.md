# Sequential paged-index optimizations on 100k Free Law Project decisions

The user requested six experiments and then explicitly skipped cache-policy changes (5). The implemented sequence is 1 → 2 → 3 → 4 → 6. Each stage was measured before moving to the next; all regressions are retained.

The measured default uses an 8 MiB bundle and reaches cold P50/P95 of 29/102 ms under +20 ms/read, versus 58/152 ms for the previous 1.82 MiB hybrid and 29/105 ms for the existing 48 MiB bundled baseline. This is a local simulation; differences of a few milliseconds should not be treated as a demonstrated deployed win. The 48 MiB optimized run measures 29/97 ms.

Competitive positional fetching regresses this workload (stage-3 P95 186 ms versus stage-2 109 ms) and remains disabled by default. The implementation and its cumulative benchmark results are preserved rather than presenting only favorable results.

## Changes

1. **Hot descriptors:** bundle 10,000 descriptors ranked by frequency in the frozen 64-query training set, then corpus document frequency. Cold terms retain the complete R2 dictionary fallback.
2. **Budgeted streams:** use the existing joint query-completion selector to embed frequency and positional streams in remaining bundle space. The entire routing root, exact lengths, compact IDs, hot dictionary and selected payloads fit the budget.
3. **Competitive positions:** load frequencies, score a conservative candidate superset, then verify positional conditions in descending exact score/document-ID order. Batches are 64, then 256, then remaining candidates; stop only when later candidates cannot beat the verified heap. This experiment regressed latency and is disabled by default.
4. **Inline tiny streams:** cold dictionary pages include both frequency and positional payloads when their combined size is at most 128 bytes and DF is at most 256. Local offsets resolve against the dictionary page owning the descriptor.
5. **Skipped:** no cache admission, eviction, page alignment or in-flight read coalescing changes.
6. **Network-aware ranges:** evaluate one through four largest-gap partitions using estimated read waves at available concurrency plus byte-transfer time. Latency and bandwidth assumptions are configurable.

## Fresh controls

| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 48-mixed | 5 | cold | 12.66 | 44.72 | 2.75 | 1204.1 | 17.97 | 13.8% |
| 48-mixed | 5 | mixed | 12.31 | 47.46 | 2.74 | 1204.0 | 15.54 | 13.8% |
| 48-mixed | 20 | cold | 28.82 | 105.28 | 2.75 | 1204.1 | 21.06 | 13.8% |
| 48-mixed | 20 | mixed | 27.72 | 99.47 | 2.73 | 1199.1 | 17.39 | 13.8% |
| hybrid-adaptive | 5 | cold | 22.25 | 60.10 | 6.86 | 1414.3 | 20.44 | 0.0% |
| hybrid-adaptive | 5 | mixed | 20.03 | 60.80 | 6.57 | 1391.0 | 17.96 | 0.0% |
| hybrid-adaptive | 20 | cold | 57.67 | 151.80 | 6.86 | 1414.3 | 29.22 | 0.0% |
| hybrid-adaptive | 20 | mixed | 55.64 | 153.41 | 6.58 | 1395.9 | 26.90 | 0.0% |

## Cumulative sequence, 8 MiB budget

Competitive positional fetching stays explicitly enabled in stages 3, 4 and 6 below to isolate cumulative changes. The production-default comparison immediately afterward disables it. Other stages use normal behavior.

| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| stage 1 | 5 | cold | 15.78 | 50.11 | 4.36 | 1383.9 | 18.85 | 0.0% |
| stage 1 | 5 | mixed | 13.65 | 54.29 | 4.20 | 1362.2 | 15.96 | 0.0% |
| stage 1 | 20 | cold | 34.54 | 124.61 | 4.36 | 1383.9 | 21.99 | 0.0% |
| stage 1 | 20 | mixed | 30.57 | 122.19 | 4.20 | 1362.2 | 19.02 | 0.0% |
| stage 2 | 5 | cold | 13.46 | 46.19 | 3.07 | 1289.4 | 18.54 | 10.0% |
| stage 2 | 5 | mixed | 12.56 | 48.70 | 3.05 | 1284.5 | 16.29 | 10.0% |
| stage 2 | 20 | cold | 30.69 | 108.82 | 3.07 | 1289.4 | 22.16 | 10.0% |
| stage 2 | 20 | mixed | 29.95 | 111.94 | 3.06 | 1289.4 | 20.53 | 10.0% |
| stage 3 | 5 | cold | 15.23 | 69.24 | 4.71 | 2345.1 | 21.40 | 10.0% |
| stage 3 | 5 | mixed | 14.61 | 70.22 | 4.69 | 2344.3 | 18.87 | 10.0% |
| stage 3 | 20 | cold | 44.52 | 186.09 | 4.71 | 2345.1 | 28.06 | 10.0% |
| stage 3 | 20 | mixed | 44.44 | 193.87 | 4.69 | 2344.3 | 26.21 | 10.0% |
| stage 4 | 5 | cold | 15.57 | 70.78 | 4.69 | 2345.4 | 21.34 | 10.0% |
| stage 4 | 5 | mixed | 14.37 | 66.41 | 4.67 | 2344.6 | 18.54 | 10.0% |
| stage 4 | 20 | cold | 43.88 | 188.27 | 4.69 | 2345.4 | 29.24 | 10.0% |
| stage 4 | 20 | mixed | 43.42 | 187.53 | 4.67 | 2344.6 | 25.08 | 10.0% |
| stage 6 | 5 | cold | 15.28 | 60.67 | 4.37 | 2432.6 | 20.59 | 10.0% |
| stage 6 | 5 | mixed | 14.83 | 60.59 | 4.34 | 2431.8 | 18.20 | 10.0% |
| stage 6 | 20 | cold | 43.68 | 161.61 | 4.14 | 2519.7 | 27.53 | 10.0% |
| stage 6 | 20 | mixed | 43.37 | 153.03 | 4.12 | 2518.9 | 22.93 | 10.0% |

## Measured default: all enabled changes except experimental positions

| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| default 8 MiB | 5 | cold | 14.93 | 59.56 | 3.00 | 1303.4 | 20.45 | 10.0% |
| default 8 MiB | 5 | mixed | 14.59 | 54.38 | 2.99 | 1303.4 | 17.19 | 10.0% |
| default 8 MiB | 20 | cold | 29.48 | 101.85 | 2.99 | 1305.4 | 21.54 | 10.0% |
| default 8 MiB | 20 | mixed | 29.23 | 104.19 | 2.98 | 1300.4 | 19.24 | 10.0% |
| default 8 MiB, 50 MiB/s | 20 | cold | 33.49 | 236.79 | 2.99 | 1305.4 | 22.44 | 10.0% |
| default 8 MiB, 50 MiB/s | 20 | mixed | 31.76 | 240.10 | 2.99 | 1305.3 | 21.36 | 10.0% |

## Bundle-budget matrix, +20 ms/read

The 8 MiB cases appear above. These additional runs compare embedding alone (2) and the final default (6), with experimental positional fetching off.

| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| stage 2, 16 MiB | 20 | cold | 29.39 | 105.50 | 2.84 | 1234.7 | 20.59 | 13.8% |
| stage 2, 16 MiB | 20 | mixed | 28.81 | 107.56 | 2.83 | 1234.7 | 19.03 | 13.8% |
| stage 2, 32 MiB | 20 | cold | 29.06 | 103.65 | 2.73 | 1132.5 | 21.53 | 13.8% |
| stage 2, 32 MiB | 20 | mixed | 29.23 | 106.18 | 2.71 | 1122.7 | 19.59 | 13.8% |
| stage 2, 48 MiB | 20 | cold | 28.90 | 96.84 | 2.64 | 812.3 | 19.88 | 15.0% |
| stage 2, 48 MiB | 20 | mixed | 28.30 | 100.29 | 2.63 | 812.3 | 19.05 | 15.0% |
| stage 6, 16 MiB | 20 | cold | 28.80 | 101.26 | 2.78 | 1248.7 | 20.85 | 13.8% |
| stage 6, 16 MiB | 20 | mixed | 28.38 | 107.13 | 2.77 | 1248.6 | 18.63 | 13.8% |
| stage 6, 32 MiB | 20 | cold | 28.23 | 101.52 | 2.71 | 1137.9 | 22.24 | 13.8% |
| stage 6, 32 MiB | 20 | mixed | 28.46 | 104.40 | 2.71 | 1137.8 | 19.24 | 13.8% |
| stage 6, 48 MiB | 20 | cold | 28.72 | 96.72 | 2.62 | 817.7 | 20.67 | 15.0% |
| stage 6, 48 MiB | 20 | mixed | 28.06 | 95.84 | 2.61 | 817.7 | 16.54 | 15.0% |

## Artifacts and startup

| Stage | Budget MiB | Actual bundle MiB | Embedded stream MiB | R2 MiB | Objects |
|---|---:|---:|---:|---:|---:|
| 1 | 8 | 2.268 | 0.000 | 430.5 | 13 |
| 2 | 8 | 7.998 | 5.730 | 430.5 | 13 |
| 3 | 8 | 7.998 | 5.730 | 430.5 | 13 |
| 4 | 8 | 7.998 | 5.730 | 442.4 | 13 |
| 6 | 8 | 7.998 | 5.730 | 442.4 | 13 |
| 2 | 16 | 15.998 | 13.730 | 430.5 | 13 |
| 2 | 32 | 31.999 | 29.731 | 430.5 | 13 |
| 2 | 48 | 47.999 | 45.731 | 430.5 | 13 |
| 6 | 16 | 15.998 | 13.730 | 442.4 | 13 |
| 6 | 32 | 31.998 | 29.730 | 442.4 | 13 |
| 6 | 48 | 47.999 | 45.731 | 442.4 | 13 |

The reader shares validated immutable routing/hot-index data between query views. Startup checks validate all bundled section CRCs once. A duplicate startup validation pass was removed after initial stage measurements; raw recorded startup times therefore reflect that earlier reader where applicable. Query timers exclude startup. Node process RSS is recorded per run and is not a measurement of Worker isolate memory. Actual packaged 8/48 MiB upload sizes are in `paged-opts-bundle-8.txt` and `paged-opts-bundle-48.txt`.

## Correctness and interpretation

84 actual local Worker HTTP responses were verified through Miniflare/workerd R2 bindings across the optimized layouts. IDs/order matched and scores agreed within 1e-12 across runtimes.

11,040 timed searches exactly matched the exhaustive reference. The reference computes exact totals before timing; tested queries request top 20 IDs/scores with totals disabled. Unit/integration tests exercise Unicode IDs, title/body fields, metadata, negative phrases, OR combinations, positional rejection of high-scoring candidates, remote/embedded/inline streams and CRC checks. No tests or benchmarks were run on a deployed Cloudflare account.

Hot descriptors remove a dependent dictionary-read phase for covered queries. Embedding selected streams provides another reduction. Inline tiny postings make a small improvement on this workload because most frequently evaluated terms already have hot descriptors. Network planning reduces requests by transferring gap bytes; the bandwidth sensitivity result is retained. Competitive positional verification saves bytes on some queries but repeatedly fetches large ranges on others, regressing this evaluation workload; it remains an explicit opt-in library/CLI option. This is not evidence that it improves production traffic.

## Method and limits

The corpus, tokenization, document IDs, scoring statistics and codecs are unchanged from [FLP-100K.md](FLP-100K.md). The frozen 160 evaluation strings have 40 queries each of plain, Boolean, phrase and proximity types. Embedding trains only on the separate frozen 64 training queries plus unsupervised corpus DF, never the evaluation query strings. These are artificial legal stress workloads, not representative user query logs. The observed coverage should not be assumed for production.

Each process runs one design/delay configuration with a bounded 4 MiB existing LRU. Cold empties it per query; mixed uses two sequential evaluation passes and includes the initially cold pass. OS filesystem caches may be warm. Exact-result checks and RSS sampling occur outside timing. Fixed per-read delays are 5 and 20 ms, with concurrent reads overlapping. The default also has a +20 ms/read, shared FIFO 50 MiB/s per-query bandwidth sensitivity run. There is no jitter, geography, server queueing or concurrent-user model. These are local simulations, not measured R2 latencies.

Root format v3 retains exact norms/IDs and a binary hot dictionary/streams; cold dictionary pages remain complete. Generation hashes include selection/packing configuration and training workload. Some stages share identical object bytes but differ in execution defaults. All objects are immutable and generation-bound. Remote copies of embedded streams are retained in packed source objects; this layout does not minimize R2 storage bytes. The v1/v2 readers and fully paged fallback remain available.

Large-corpus memory guards, the cost of bundling per-document norms/IDs, and exact deep pagination remain limitations. These 100k results do not establish 10m capacity, startup CPU compliance or concurrent isolate memory safety. The experimental ranked-candidate buffer is charged to the working-set estimate.

## Reproduce

```sh
# Use fresh output directories for immutable builds.
node --import tsx bench/build-paged-opts.ts 1 8
PAGED_DESIGNS=opt1-8 PAGED_PREFIX=paged-opts PAGED_DELAYS=5,20 node --import tsx bench/paged.ts
# Repeat for stages 2, 3, 4, 6 in that order.
PAGED_DESIGNS=opt6-8 PAGED_PREFIX=paged-opts-default PAGED_COMPETITIVE=false PAGED_DELAYS=5,20 node --import tsx bench/paged.ts
PAGED_DESIGNS=opt6-8 PAGED_PREFIX=paged-opts-default PAGED_COMPETITIVE=false PAGED_DELAYS=20 PAGED_BANDWIDTH_MIB=50 node --import tsx bench/paged.ts
node --import tsx bench/paged-opts-matrix.ts
PAGED_DESIGNS=48-mixed,hybrid-adaptive PAGED_PREFIX=paged-opts-control PAGED_DELAYS=5,20 node --import tsx bench/paged.ts
PAGED_DESIGNS=opt1-8,opt2-8,opt3-8,opt4-8,opt6-8,opt6-48 PAGED_PREFIX=paged-opts node --import tsx bench/paged-worker.ts
python3 bench/paged-opts-report.py
```
