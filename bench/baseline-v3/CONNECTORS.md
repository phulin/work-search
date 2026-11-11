# Positional terms-and-connectors benchmark

Format v3 stores body/title token positions in every posting. The compressed document table is unchanged. All 24 configurations use the same seed-42 corpora, budgets, and embedding policies as the optimized v2 baseline preserved in baseline-v2-optimized/. Baseline plain-term queries still use the same twelve queries × three passes; seven separate connector queries × three passes are **not** included in the embedding-policy training workload. Workload-aware plain-term results remain optimistic.

Measurements are local Node HTTP-handler/filesystem ranges with warm OS caches, not deployed Cloudflare latency. CPU is process CPU; peak RSS includes offline indexing. Positional checks decode only candidate-document positions, with no corpus-wide map of match spans. Early resource-limit failures are preserved as failures rather than counted as zero matches.

## Plain-term comparison (v2 → v3)

|    Docs | Budget MiB | Policy   |    Postings MiB |    Bundle MiB | Zero index reads % | Reads/query |          P95 ms | Build seconds |
| ------: | ---------: | -------- | --------------: | ------------: | -----------------: | ----------: | --------------: | ------------: |
|   10000 |          8 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.09 → 4.69 |   0.52 → 0.69 |
|   10000 |          8 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     3.92 → 4.87 |   0.56 → 0.69 |
|   10000 |         16 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.31 → 4.73 |   0.59 → 0.71 |
|   10000 |         16 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.43 → 4.71 |   0.61 → 0.71 |
|   10000 |         32 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.23 → 4.74 |   0.52 → 0.69 |
|   10000 |         32 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     3.85 → 4.76 |   0.53 → 0.70 |
|   10000 |         48 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     3.84 → 4.71 |   0.52 → 0.69 |
|   10000 |         48 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.21 → 4.72 |   0.54 → 0.69 |
|  100000 |          8 | smallest |   15.12 → 19.60 |   8.00 → 8.00 |        25.0 → 25.0 | 1.08 → 1.08 |   21.65 → 26.93 |   3.30 → 4.92 |
|  100000 |          8 | workload |   15.12 → 19.60 |   8.00 → 8.00 |      100.0 → 100.0 | 0.00 → 0.00 |   20.52 → 26.00 |   3.26 → 5.03 |
|  100000 |         16 | smallest |   15.12 → 19.60 | 15.84 → 16.00 |        91.7 → 50.0 | 0.17 → 0.67 |   28.00 → 32.67 |   3.44 → 4.87 |
|  100000 |         16 | workload |   15.12 → 19.60 | 15.97 → 16.00 |      100.0 → 100.0 | 0.00 → 0.00 |   22.06 → 26.47 |   3.55 → 4.82 |
|  100000 |         32 | smallest |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   21.58 → 26.28 |   3.39 → 4.83 |
|  100000 |         32 | workload |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   21.95 → 26.32 |   3.49 → 4.82 |
|  100000 |         48 | smallest |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   21.23 → 26.33 |   3.42 → 4.75 |
|  100000 |         48 | workload |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   29.05 → 26.68 |   3.38 → 4.81 |
| 1000000 |          8 | smallest | 151.00 → 195.82 |   8.00 → 8.00 |        16.7 → 16.7 | 1.17 → 1.17 | 135.33 → 200.63 | 44.61 → 71.37 |
| 1000000 |          8 | workload | 151.00 → 195.82 |   8.00 → 8.00 |        58.3 → 58.3 | 0.50 → 0.50 | 128.44 → 161.87 | 46.17 → 74.56 |
| 1000000 |         16 | smallest | 151.00 → 195.82 | 16.00 → 16.00 |        16.7 → 16.7 | 1.17 → 1.17 | 128.80 → 161.40 | 44.96 → 69.64 |
| 1000000 |         16 | workload | 151.00 → 195.82 | 16.00 → 16.00 |        91.7 → 91.7 | 0.08 → 0.17 | 129.59 → 161.45 | 43.68 → 72.27 |
| 1000000 |         32 | smallest | 151.00 → 195.82 | 32.00 → 32.00 |        25.0 → 16.7 | 1.08 → 1.17 | 143.38 → 163.87 | 42.48 → 71.06 |
| 1000000 |         32 | workload | 151.00 → 195.82 | 32.00 → 32.00 |      100.0 → 100.0 | 0.00 → 0.00 | 119.78 → 154.67 | 40.69 → 68.68 |
| 1000000 |         48 | smallest | 151.00 → 195.82 | 48.00 → 48.00 |        25.0 → 25.0 | 1.08 → 1.08 | 126.27 → 164.52 | 40.23 → 73.75 |
| 1000000 |         48 | workload | 151.00 → 195.82 | 48.00 → 48.00 |      100.0 → 100.0 | 0.00 → 0.00 | 132.65 → 152.88 | 40.37 → 69.23 |

## Connector suite

|    Docs | Budget MiB | Policy   | Zero reads % | Reads/query | Bytes/query | P50 ms |  P95 ms | CPU ms/query | Failures |
| ------: | ---------: | -------- | -----------: | ----------: | ----------: | -----: | ------: | -----------: | -------: |
|   10000 |          8 | smallest |        100.0 |        0.00 |           0 |   1.00 |    9.14 |        12.12 |        0 |
|   10000 |          8 | workload |        100.0 |        0.00 |           0 |   1.01 |    9.46 |        11.57 |        0 |
|   10000 |         16 | smallest |        100.0 |        0.00 |           0 |   1.03 |    8.87 |        11.27 |        0 |
|   10000 |         16 | workload |        100.0 |        0.00 |           0 |   1.03 |    9.44 |        12.43 |        0 |
|   10000 |         32 | smallest |        100.0 |        0.00 |           0 |   1.01 |    9.59 |        11.33 |        0 |
|   10000 |         32 | workload |        100.0 |        0.00 |           0 |   0.98 |    9.09 |        11.39 |        0 |
|   10000 |         48 | smallest |        100.0 |        0.00 |           0 |   1.01 |    9.06 |        12.10 |        0 |
|   10000 |         48 | workload |        100.0 |        0.00 |           0 |   1.02 |    9.45 |        11.66 |        0 |
|  100000 |          8 | smallest |         14.3 |        2.29 |      470266 |   7.40 |   73.52 |        48.34 |        0 |
|  100000 |          8 | workload |         85.7 |        0.14 |         715 |   8.89 |   67.06 |        38.28 |        0 |
|  100000 |         16 | smallest |         14.3 |        1.57 |      466693 |   9.29 |   68.59 |        40.71 |        0 |
|  100000 |         16 | workload |         85.7 |        0.14 |         715 |   9.00 |   66.74 |        38.05 |        0 |
|  100000 |         32 | smallest |        100.0 |        0.00 |           0 |   8.14 |   64.81 |        38.90 |        0 |
|  100000 |         32 | workload |        100.0 |        0.00 |           0 |   8.19 |   65.49 |        36.92 |        0 |
|  100000 |         48 | smallest |        100.0 |        0.00 |           0 |   8.13 |   66.23 |        36.64 |        0 |
|  100000 |         48 | workload |        100.0 |        0.00 |           0 |   8.11 |   66.17 |        39.10 |        0 |
| 1000000 |          8 | smallest |         14.3 |        2.29 |     4701597 |  74.67 | 1130.42 |       623.36 |        0 |
| 1000000 |          8 | workload |         28.6 |        1.29 |     4523627 |  74.27 |  900.20 |       700.93 |        0 |
| 1000000 |         16 | smallest |         14.3 |        2.29 |     4701597 |  74.02 |  913.08 |       614.39 |        0 |
| 1000000 |         16 | workload |         42.9 |        0.86 |     2864288 |  70.62 |  725.83 |       426.57 |        0 |
| 1000000 |         32 | smallest |         14.3 |        2.29 |     4701597 |  75.84 |  891.70 |       699.43 |        0 |
| 1000000 |         32 | workload |         85.7 |        0.14 |        7143 |  91.88 |  794.59 |       449.53 |        0 |
| 1000000 |         48 | smallest |         14.3 |        2.29 |     4701597 |  73.52 |  894.61 |       664.78 |        0 |
| 1000000 |         48 | workload |         85.7 |        0.14 |        7143 |  74.65 |  830.63 |       479.55 |        0 |

Connector queries include an exact common phrase, common-term /s, category/word /p, grouped OR with AND, phrase exclusion, a rare phrase, and grouped proximity. They measure correctness-oriented exhaustive evaluation, not a proprietary Lexis implementation. Common phrases can examine one million candidates and are substantially more CPU-intensive than term-only search. Typed-array offsets are allocated only for positional queries; individual candidate positions are decoded on demand. The fixed workload is small, so tail percentiles have limited confidence. Metadata is not requested.

Raw per-query totals, errors, I/O, CPU and timings are in results/results.json and individual configuration JSONs. Actual local workerd HTTP results are in WORKERD.md. No Cloudflare deployment or network measurements were performed. See docs/QUERY.md for exact supported syntax, precedence, matching rules and safeguards.
