# Positional terms-and-connectors benchmark

Format v3 stores body/title token positions in every posting. The compressed document table is unchanged. All 24 configurations use the same seed-42 corpora, budgets, and embedding policies as the optimized v2 baseline preserved in baseline-v2-optimized/. Baseline plain-term queries still use the same twelve queries × three passes; seven separate connector queries × three passes are **not** included in the embedding-policy training workload. Workload-aware plain-term results remain optimistic.

Measurements are local Node HTTP-handler/filesystem ranges with warm OS caches, not deployed Cloudflare latency. CPU is process CPU. In --reuse-indexes runs, construction timings/RSS are inherited baseline figures; query timings and query-process RSS are new, and exclude the offline builder. Reused objects and bundle hashes are verified before queries. Positional checks decode only candidate-document positions, with no corpus-wide map of match spans. Early resource-limit failures are preserved as failures rather than counted as zero matches.

## Plain-term comparison (v2 → v3)

|    Docs | Budget MiB | Policy   |    Postings MiB |    Bundle MiB | Zero index reads % | Reads/query |          P95 ms | Build seconds |
| ------: | ---------: | -------- | --------------: | ------------: | -----------------: | ----------: | --------------: | ------------: |
|   10000 |          8 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.09 → 6.70 |   0.52 → 0.69 |
|   10000 |          8 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     3.92 → 5.10 |   0.56 → 0.69 |
|   10000 |         16 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.31 → 4.99 |   0.59 → 0.71 |
|   10000 |         16 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.43 → 5.07 |   0.61 → 0.71 |
|   10000 |         32 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.23 → 5.14 |   0.52 → 0.69 |
|   10000 |         32 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     3.85 → 5.02 |   0.53 → 0.70 |
|   10000 |         48 | smallest |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     3.84 → 5.10 |   0.52 → 0.69 |
|   10000 |         48 | workload |     1.52 → 1.97 |   2.28 → 2.73 |      100.0 → 100.0 | 0.00 → 0.00 |     4.21 → 5.06 |   0.54 → 0.69 |
|  100000 |          8 | smallest |   15.12 → 19.60 |   8.00 → 8.00 |        25.0 → 25.0 | 1.08 → 1.08 |   21.65 → 27.06 |   3.30 → 4.92 |
|  100000 |          8 | workload |   15.12 → 19.60 |   8.00 → 8.00 |      100.0 → 100.0 | 0.00 → 0.00 |   20.52 → 27.36 |   3.26 → 5.03 |
|  100000 |         16 | smallest |   15.12 → 19.60 | 15.84 → 16.00 |        91.7 → 50.0 | 0.17 → 0.67 |   28.00 → 27.01 |   3.44 → 4.87 |
|  100000 |         16 | workload |   15.12 → 19.60 | 15.97 → 16.00 |      100.0 → 100.0 | 0.00 → 0.00 |   22.06 → 26.97 |   3.55 → 4.82 |
|  100000 |         32 | smallest |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   21.58 → 26.82 |   3.39 → 4.83 |
|  100000 |         32 | workload |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   21.95 → 26.68 |   3.49 → 4.82 |
|  100000 |         48 | smallest |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   21.23 → 26.93 |   3.42 → 4.75 |
|  100000 |         48 | workload |   15.12 → 19.60 | 16.41 → 20.89 |      100.0 → 100.0 | 0.00 → 0.00 |   29.05 → 26.80 |   3.38 → 4.81 |
| 1000000 |          8 | smallest | 151.00 → 195.82 |   8.00 → 8.00 |        16.7 → 16.7 | 1.17 → 1.17 | 135.33 → 167.30 | 44.61 → 71.37 |
| 1000000 |          8 | workload | 151.00 → 195.82 |   8.00 → 8.00 |        58.3 → 58.3 | 0.50 → 0.50 | 128.44 → 164.71 | 46.17 → 74.56 |
| 1000000 |         16 | smallest | 151.00 → 195.82 | 16.00 → 16.00 |        16.7 → 16.7 | 1.17 → 1.17 | 128.80 → 164.68 | 44.96 → 69.64 |
| 1000000 |         16 | workload | 151.00 → 195.82 | 16.00 → 16.00 |        91.7 → 91.7 | 0.08 → 0.17 | 129.59 → 162.35 | 43.68 → 72.27 |
| 1000000 |         32 | smallest | 151.00 → 195.82 | 32.00 → 32.00 |        25.0 → 16.7 | 1.08 → 1.17 | 143.38 → 166.46 | 42.48 → 71.06 |
| 1000000 |         32 | workload | 151.00 → 195.82 | 32.00 → 32.00 |      100.0 → 100.0 | 0.00 → 0.00 | 119.78 → 160.91 | 40.69 → 68.68 |
| 1000000 |         48 | smallest | 151.00 → 195.82 | 48.00 → 48.00 |        25.0 → 25.0 | 1.08 → 1.08 | 126.27 → 164.04 | 40.23 → 73.75 |
| 1000000 |         48 | workload | 151.00 → 195.82 | 48.00 → 48.00 |      100.0 → 100.0 | 0.00 → 0.00 | 132.65 → 161.38 | 40.37 → 69.23 |

## Connector suite

|    Docs | Budget MiB | Policy   | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Failures |
| ------: | ---------: | -------- | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -------: |
|   10000 |          8 | smallest |        100.0 |        0.00 |           0 |   0.99 |   6.33 |         5.88 |        0 |
|   10000 |          8 | workload |        100.0 |        0.00 |           0 |   1.07 |   6.40 |         8.00 |        0 |
|   10000 |         16 | smallest |        100.0 |        0.00 |           0 |   0.97 |   6.04 |         7.43 |        0 |
|   10000 |         16 | workload |        100.0 |        0.00 |           0 |   1.03 |   6.52 |         6.16 |        0 |
|   10000 |         32 | smallest |        100.0 |        0.00 |           0 |   1.04 |   7.11 |         6.86 |        0 |
|   10000 |         32 | workload |        100.0 |        0.00 |           0 |   1.05 |   6.10 |         7.71 |        0 |
|   10000 |         48 | smallest |        100.0 |        0.00 |           0 |   1.05 |   6.57 |         7.82 |        0 |
|   10000 |         48 | workload |        100.0 |        0.00 |           0 |   1.00 |   6.01 |         7.40 |        0 |
|  100000 |          8 | smallest |         14.3 |        2.29 |      470266 |   7.02 |  38.93 |        26.72 |        0 |
|  100000 |          8 | workload |         85.7 |        0.14 |         715 |   9.41 |  40.27 |        27.94 |        0 |
|  100000 |         16 | smallest |         14.3 |        1.57 |      466693 |   6.76 |  38.40 |        26.39 |        0 |
|  100000 |         16 | workload |         85.7 |        0.14 |         715 |   6.88 |  37.32 |        24.77 |        0 |
|  100000 |         32 | smallest |        100.0 |        0.00 |           0 |   6.93 |  35.57 |        25.46 |        0 |
|  100000 |         32 | workload |        100.0 |        0.00 |           0 |   6.72 |  37.02 |        26.02 |        0 |
|  100000 |         48 | smallest |        100.0 |        0.00 |           0 |   6.89 |  35.46 |        25.69 |        0 |
|  100000 |         48 | workload |        100.0 |        0.00 |           0 |   6.70 |  35.81 |        26.19 |        0 |
| 1000000 |          8 | smallest |         14.3 |        2.29 |     4701597 |  60.21 | 307.61 |       160.45 |        0 |
| 1000000 |          8 | workload |         28.6 |        1.29 |     4523627 |  57.04 | 295.36 |       158.32 |        0 |
| 1000000 |         16 | smallest |         14.3 |        2.29 |     4701597 |  58.77 | 303.13 |       158.36 |        0 |
| 1000000 |         16 | workload |         42.9 |        0.86 |     2864288 |  60.51 | 309.80 |       158.08 |        0 |
| 1000000 |         32 | smallest |         14.3 |        2.29 |     4701597 |  57.80 | 307.54 |       159.64 |        0 |
| 1000000 |         32 | workload |         85.7 |        0.14 |        7143 |  55.61 | 316.04 |       160.40 |        0 |
| 1000000 |         48 | smallest |         14.3 |        2.29 |     4701597 |  59.56 | 303.17 |       156.39 |        0 |
| 1000000 |         48 | workload |         85.7 |        0.14 |        7143 |  58.07 | 306.86 |       156.94 |        0 |

Connector queries include an exact common phrase, common-term /s, category/word /p, grouped OR with AND, phrase exclusion, a rare phrase, and grouped proximity. They measure correctness-oriented exhaustive evaluation, not a proprietary Lexis implementation. Common phrases can examine one million candidates and are substantially more CPU-intensive than term-only search. Typed-array offsets are allocated only for positional queries; individual candidate positions are decoded on demand. The fixed workload is small, so tail percentiles have limited confidence. Metadata is not requested.

Raw per-query totals, errors, I/O, CPU and timings are in results/results.json and individual configuration JSONs. Actual local workerd HTTP results are in WORKERD.md. No Cloudflare deployment or network measurements were performed. See docs/QUERY.md for exact supported syntax, precedence, matching rules and safeguards.
