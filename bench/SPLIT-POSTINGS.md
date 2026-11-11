# Split frequency and position postings (v3 → v4)

Format v4 independently encodes and locates document IDs/term frequencies and field positions. The Worker dictionary contains complete descriptors for both streams; no remote dictionary lookup is added. Plain terms and Boolean expressions fetch and decode **frequency bytes only**, with zero positional range reads, zero position CRC traversal, and no positional offsets allocated. Phrase/proximity expressions fetch positions only for location-dependent terms. Frequency and position jobs share the same concurrency-four queue, so streams can arrive in parallel. Exact matching, ranking and query syntax are unchanged.

The previous optimized v3 results are preserved in baseline-v3-optimized/. This run rebuilds the same corpora (10k/100k/1m, seed 42), all four unchanged budgets and both policies. The twelve plain queries and seven separate connector queries use three passes each, top 20, IDs only. Workload-aware embedding is trained on the plain-term workload, so plain-query local-hit rates are optimistic. All measurements are local Node HTTP handler/filesystem, not deployed Cloudflare latency. Peak process RSS includes indexing only in fresh-build runs; inherited construction figures in reuse runs are labeled in raw results.

## Plain-term queries

Columns show **v3 → v4**. Each v4 plain query is checked to have zero positional requests/bytes. Frequencies get embedding priority; positions are eligible for remaining space only when their frequency stream is embedded. Both smallest-first and workload selection are applied independently within each tier. This policy favors plain-term local hit rates and does not attempt a globally optimal mixed-workload allocation.

|    Docs | Budget MiB | Policy   | Frequency MiB | Position MiB | Dictionary MiB |  Zero reads % | Reads/query |       Bytes/query |      P50 ms |          P95 ms |  CPU ms/query |       Build s | Failures |
| ------: | ---------: | -------- | ------------: | -----------: | -------------: | ------------: | ----------: | ----------------: | ----------: | --------------: | ------------: | ------------: | -------: |
|   10000 |          8 | smallest |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.22 → 0.23 |     6.70 → 4.17 |   3.51 → 2.74 |   0.69 → 0.88 |        0 |
|   10000 |          8 | workload |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.23 → 0.23 |     5.10 → 4.01 |   3.28 → 2.52 |   0.69 → 0.90 |        0 |
|   10000 |         16 | smallest |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.22 → 0.30 |     4.99 → 4.73 |   3.47 → 3.07 |   0.71 → 0.87 |        0 |
|   10000 |         16 | workload |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.24 → 0.30 |     5.07 → 4.75 |   3.44 → 2.97 |   0.71 → 1.09 |        0 |
|   10000 |         32 | smallest |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.29 → 0.23 |     5.14 → 4.17 |   3.30 → 2.65 |   0.69 → 0.93 |        0 |
|   10000 |         32 | workload |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.24 → 0.24 |     5.02 → 4.00 |   3.42 → 2.54 |   0.70 → 0.87 |        0 |
|   10000 |         48 | smallest |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.23 → 0.22 |     5.10 → 4.08 |   3.06 → 2.37 |   0.69 → 0.87 |        0 |
|   10000 |         48 | workload |          1.52 |         0.54 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.23 → 0.24 |     5.06 → 4.07 |   3.49 → 2.67 |   0.69 → 0.91 |        0 |
|  100000 |          8 | smallest |         15.12 |         4.59 |           0.93 |   25.0 → 25.0 | 1.08 → 1.08 |   202272 → 138328 | 1.04 → 0.83 |   27.06 → 22.73 |   9.95 → 7.98 |   4.92 → 5.19 |        0 |
|  100000 |          8 | workload |         15.12 |         4.59 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.79 → 0.62 |   27.36 → 25.59 |   9.45 → 7.24 |   5.03 → 5.09 |        0 |
|  100000 |         16 | smallest |         15.12 |         4.59 |           0.93 |   50.0 → 83.3 | 0.67 → 0.25 |    200717 → 75001 | 0.91 → 0.65 |   27.01 → 22.64 |   9.64 → 6.96 |   4.87 → 5.12 |        0 |
|  100000 |         16 | workload |         15.12 |         4.59 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.77 → 0.64 |   26.97 → 21.96 |   9.00 → 7.05 |   4.82 → 5.08 |        0 |
|  100000 |         32 | smallest |         15.12 |         4.59 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.79 → 0.66 |   26.82 → 21.81 |   9.64 → 7.20 |   4.83 → 5.02 |        0 |
|  100000 |         32 | workload |         15.12 |         4.59 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.77 → 0.65 |   26.68 → 21.96 |   9.67 → 6.72 |   4.82 → 5.02 |        0 |
|  100000 |         48 | smallest |         15.12 |         4.59 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.80 → 0.66 |   26.93 → 21.94 |   9.59 → 6.83 |   4.75 → 5.06 |        0 |
|  100000 |         48 | workload |         15.12 |         4.59 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 0.81 → 0.64 |   26.80 → 22.06 |   9.66 → 6.75 |   4.81 → 5.15 |        0 |
| 1000000 |          8 | smallest |        151.00 |        44.94 |           0.93 |   16.7 → 16.7 | 1.17 → 1.17 | 2022124 → 1383773 | 4.11 → 5.05 | 167.30 → 146.09 | 44.60 → 39.64 | 71.37 → 71.45 |        0 |
| 1000000 |          8 | workload |        151.00 |        44.94 |           0.93 |   58.3 → 58.3 | 0.50 → 0.50 | 1951922 → 1333317 | 4.49 → 3.17 | 164.71 → 138.92 | 46.01 → 40.40 | 74.56 → 76.06 |        0 |
| 1000000 |         16 | smallest |        151.00 |        44.94 |           0.93 |   16.7 → 16.7 | 1.17 → 1.17 | 2022124 → 1383773 | 4.18 → 5.09 | 164.68 → 149.41 | 46.53 → 39.67 | 69.64 → 74.85 |        0 |
| 1000000 |         16 | workload |        151.00 |        44.94 |           0.93 |   91.7 → 91.7 | 0.17 → 0.08 |   666667 → 250000 | 3.92 → 7.71 | 162.35 → 213.42 | 43.80 → 45.38 | 72.27 → 70.31 |        0 |
| 1000000 |         32 | smallest |        151.00 |        44.94 |           0.93 |   16.7 → 25.0 | 1.17 → 1.08 | 2022124 → 1383463 | 4.16 → 4.48 | 166.46 → 136.45 | 46.63 → 36.93 | 71.06 → 69.69 |        0 |
| 1000000 |         32 | workload |        151.00 |        44.94 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 3.98 → 3.42 | 160.91 → 133.54 | 43.39 → 35.25 | 68.68 → 77.28 |        0 |
| 1000000 |         48 | smallest |        151.00 |        44.94 |           0.93 |   25.0 → 25.0 | 1.08 → 1.08 | 2021735 → 1383463 | 4.13 → 4.40 | 164.04 → 138.80 | 45.44 → 36.92 | 73.75 → 67.37 |        0 |
| 1000000 |         48 | workload |        151.00 |        44.94 |           0.93 | 100.0 → 100.0 | 0.00 → 0.00 |             0 → 0 | 3.97 → 3.69 | 161.38 → 136.94 | 43.37 → 35.79 | 69.23 → 70.80 |        0 |

## Connector-query tradeoff

Splitting can add a position-range request to a term that previously needed one combined range. Frequency-first embedding can leave positions remote even when all frequencies are bundled. Transfers are smaller per stream, but query-local hit rates and remote request counts can worsen for positional workloads. These costs are reported rather than hidden. API diagnostics separate frequency and position requests/bytes; index totals remain their sum, excluding optional metadata.

|    Docs | Budget MiB | Policy   | Zero reads % v3 → v4 | Reads/query v3 → v4 | Bytes/query v3 → v4 |  P95 ms v3 → v4 | v4 position reads/query | v4 failures |
| ------: | ---------: | -------- | -------------------: | ------------------: | ------------------: | --------------: | ----------------------: | ----------: |
|   10000 |          8 | smallest |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.33 → 7.06 |                    0.00 |           0 |
|   10000 |          8 | workload |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.40 → 8.26 |                    0.00 |           0 |
|   10000 |         16 | smallest |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.04 → 7.68 |                    0.00 |           0 |
|   10000 |         16 | workload |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.52 → 8.85 |                    0.00 |           0 |
|   10000 |         32 | smallest |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     7.11 → 8.33 |                    0.00 |           0 |
|   10000 |         32 | workload |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.10 → 8.23 |                    0.00 |           0 |
|   10000 |         48 | smallest |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.57 → 8.00 |                    0.00 |           0 |
|   10000 |         48 | workload |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |     6.01 → 8.26 |                    0.00 |           0 |
|  100000 |          8 | smallest |           14.3 → 0.0 |         2.29 → 4.29 |     470266 → 467341 |   38.93 → 36.85 |                    2.00 |           0 |
|  100000 |          8 | workload |          85.7 → 14.3 |         0.14 → 2.14 |        715 → 130761 |   40.27 → 45.64 |                    2.00 |           0 |
|  100000 |         16 | smallest |          14.3 → 14.3 |         1.57 → 2.71 |     466693 → 387468 |   38.40 → 37.69 |                    1.86 |           0 |
|  100000 |         16 | workload |          85.7 → 28.6 |         0.14 → 1.43 |        715 → 129736 |   37.32 → 36.56 |                    1.43 |           0 |
|  100000 |         32 | smallest |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |   35.57 → 34.98 |                    0.00 |           0 |
|  100000 |         32 | workload |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |   37.02 → 34.98 |                    0.00 |           0 |
|  100000 |         48 | smallest |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |   35.46 → 35.09 |                    0.00 |           0 |
|  100000 |         48 | workload |        100.0 → 100.0 |         0.00 → 0.00 |               0 → 0 |   35.81 → 35.05 |                    0.00 |           0 |
| 1000000 |          8 | smallest |           14.3 → 0.0 |         2.29 → 4.29 |   4701597 → 4672106 | 307.61 → 300.60 |                    2.00 |           0 |
| 1000000 |          8 | workload |          28.6 → 28.6 |         1.29 → 3.00 |   4523627 → 4544000 | 295.36 → 310.67 |                    1.71 |           0 |
| 1000000 |         16 | smallest |           14.3 → 0.0 |         2.29 → 4.29 |   4701597 → 4672106 | 303.13 → 326.66 |                    2.00 |           0 |
| 1000000 |         16 | workload |          42.9 → 28.6 |         0.86 → 2.14 |   2864288 → 2163065 | 309.80 → 621.81 |                    1.71 |           0 |
| 1000000 |         32 | smallest |           14.3 → 0.0 |         2.29 → 4.29 |   4701597 → 4672106 | 307.54 → 305.31 |                    2.00 |           0 |
| 1000000 |         32 | workload |          85.7 → 14.3 |         0.14 → 2.14 |      7143 → 1306120 | 316.04 → 343.91 |                    2.00 |           0 |
| 1000000 |         48 | smallest |           14.3 → 0.0 |         2.29 → 4.29 |   4701597 → 4672106 | 303.17 → 307.77 |                    2.00 |           0 |
| 1000000 |         48 | workload |          85.7 → 28.6 |         0.14 → 1.86 |      7143 → 1305921 | 306.86 → 308.26 |                    1.71 |           0 |

## Correctness and migration

Unit/integration tests cover plain Boolean queries with positional storage disabled, independently embedded frequency/position combinations, selective positional terms, stream CRCs and cross-stream binding, corrupt positional descriptors, Unicode, phrases, proximity and exact BM25 results across budgets. The positional stream stores the CRC32 of its corresponding frequency bytes; generation-scoped keys and both dictionary CRCs are still verified. CRCs are integrity checks, not authentication against a malicious writer.

A complete v4 generation is required: rebuild indexes and deploy the matching v4 Worker. The 40-byte term descriptor adds 12 bytes per vocabulary term; the compact document-table format remains DTC2. Streams are packed into separate immutable frequencies-N.bin and positions-N.bin objects, with independent local/remote offsets and byte ranges. No per-term tiny objects are created. Old v3 indexes cannot be served by the v4 reader.

Raw samples are in results/results.json and the individual configuration JSON files, including all frequency/position diagnostics and failures. Actual local workerd measurements are in WORKERD.md. This small synthetic workload gives limited tail-latency confidence; no Cloudflare deployment or production-network measurements are claimed.

## Paired cross-format validation

The preserved v3 builds and new v4 builds contain identical ordered documents. One warmup and three alternating-order measured passes compare full API result IDs/scores and exact total counts for every plain and connector query. Index layout and embedding policy both change, so I/O is reported rather than required to be identical. The same-process comparison reduces between-run scheduling noise but remains local filesystem/search execution, not deployed Cloudflare latency.

| Configuration       | Suite      | v3 P95 ms | v4 P95 ms | v3 reads/query | v4 reads/query | v3 bytes/query | v4 bytes/query |
| ------------------- | ---------- | --------: | --------: | -------------: | -------------: | -------------: | -------------: |
| 100000-8-workload   | plain      |     14.28 |     12.48 |           0.00 |           0.00 |              0 |              0 |
| 100000-8-workload   | connectors |     41.78 |     37.50 |           0.14 |           2.14 |            715 |         130761 |
| 1000000-48-workload | plain      |    136.01 |    123.22 |           0.00 |           0.00 |              0 |              0 |
| 1000000-48-workload | connectors |    274.44 |    279.42 |           0.14 |           1.86 |           7143 |        1305921 |

Raw pairs are in results/paired-split.json. To reproduce, retain v3 builds from commit 64302c5 at bench/generated/v3-100000-8-workload and bench/generated/v3-1000000-48-workload, using the same generated corpora and query workload. Build the matching v4 configurations, then run `node --import tsx bench/paired-split.ts` and `node --import tsx bench/split-postings-report.ts`. V3 source and index-reader snapshots are preserved in baseline-v3-optimized/.
