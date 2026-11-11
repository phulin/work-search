# Document-table compression: v1 → v2

The v1 baseline and complete raw results are preserved in baseline-v1/. Both runs use the same Apple M3 host, deterministic corpus seed 42, twelve queries, three passes each, and budget/selection matrix. Measurements were collected in separate runs, not interleaved: timing changes include runtime noise, host load, and memory/GC effects. They are local Node HTTP-handler/filesystem results, not Cloudflare latency. No artificial network delay is applied. Workload-aware selection is trained on the benchmark queries and therefore optimistic.

## Table size

| Documents | v1 table MiB | v2 table MiB | Reduction | Mandatory dictionary + table MiB |
| --------: | -----------: | -----------: | --------: | -------------------------------: |
|     10000 |         0.30 |         0.06 |     80.6% |                             0.76 |
|    100000 |         3.14 |         0.59 |     81.1% |                             1.29 |
|   1000000 |        32.32 |         5.97 |     81.5% |                             6.67 |

The million-document v1 mandatory tables consumed 33.02 MiB and rejected 8, 16, and 32 MiB budgets. Format v2 fits all four budgets without paging IDs or lengths to R2. Lengths use block minima plus bit-packed deltas; IDs use UTF-8 prefix sharing; metadata uses contiguous pointers with explicit exceptions. Scoring accesses lengths directly, while winner ID decoding scans at most 32 records. Per-block CRC validation is lazy and uses a one-bit-per-block bitmap (3,907 bytes for one million documents). There is no full-table expansion at startup. Compression depends on ID/length/pointer distributions; arbitrary corpora need not achieve this ratio.

## Full matrix

Columns show **v1 → v2**. “Infeasible” means the old mandatory data exceeded the bundle budget. P50/P95 timings are milliseconds. RSS is offline build+query process peak, not Worker isolate memory.

|    Docs | Budget MiB | Policy   |         Bundle MiB |       Zero reads % |       Reads/query |          Bytes/query |            P50 ms |              P95 ms |       CPU ms/query |            Build s |         Peak RSS MiB |
| ------: | ---------: | -------- | -----------------: | -----------------: | ----------------: | -------------------: | ----------------: | ------------------: | -----------------: | -----------------: | -------------------: |
|   10000 |          8 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.19 |         5.80 → 4.44 |        2.39 → 2.62 |        0.50 → 0.50 |      239.63 → 234.63 |
|   10000 |          8 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.17 → 0.23 |         4.18 → 5.68 |        2.26 → 2.98 |        0.50 → 0.52 |      227.19 → 226.42 |
|   10000 |         16 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.21 |         4.19 → 4.50 |        2.31 → 2.91 |        0.50 → 0.53 |      226.73 → 224.44 |
|   10000 |         16 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.23 |         4.18 → 4.36 |        2.21 → 2.74 |        0.52 → 0.52 |      226.48 → 226.20 |
|   10000 |         32 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.16 → 0.20 |         4.20 → 4.34 |        2.22 → 2.66 |        0.50 → 0.51 |      226.91 → 224.02 |
|   10000 |         32 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.23 |         4.21 → 4.35 |        2.33 → 2.71 |        0.50 → 0.52 |      226.69 → 218.91 |
|   10000 |         48 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.14 → 0.23 |         5.63 → 4.56 |        2.28 → 2.73 |        0.50 → 0.50 |      226.77 → 225.36 |
|   10000 |         48 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.16 → 0.21 |         4.13 → 6.09 |        2.20 → 2.95 |        0.51 → 0.52 |      226.84 → 225.42 |
|  100000 |          8 | smallest |        8.00 → 8.00 |        25.0 → 25.0 |       1.08 → 1.08 |      138328 → 138328 |       0.76 → 0.72 |       20.42 → 23.00 |        7.63 → 8.33 |        3.15 → 3.18 |      390.94 → 394.50 |
|  100000 |          8 | workload |        8.00 → 8.00 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.53 → 0.63 |       21.34 → 22.97 |        7.13 → 8.10 |        3.31 → 3.18 |      393.42 → 468.13 |
|  100000 |         16 | smallest |      16.00 → 15.84 |        50.0 → 91.7 |       0.67 → 0.17 |       137339 → 50001 |       0.74 → 0.64 |       25.68 → 22.88 |        8.49 → 8.23 |        3.11 → 3.40 |      405.08 → 378.66 |
|  100000 |         16 | workload |      16.00 → 15.97 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.62 |       20.59 → 21.84 |        7.11 → 7.89 |        3.08 → 3.40 |      438.78 → 407.22 |
|  100000 |         32 | smallest |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.63 |       21.72 → 21.83 |        7.24 → 7.83 |        3.11 → 3.26 |      416.28 → 427.38 |
|  100000 |         32 | workload |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.54 → 0.63 |       21.27 → 22.40 |        7.25 → 7.84 |        3.11 → 3.28 |      452.58 → 395.67 |
|  100000 |         48 | smallest |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.65 |       21.28 → 21.86 |        7.16 → 7.79 |        3.12 → 3.14 |      409.42 → 396.11 |
|  100000 |         48 | workload |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.63 |       21.00 → 22.12 |        7.11 → 7.83 |        3.11 → 3.16 |      401.84 → 424.73 |
| 1000000 |          8 | smallest |  infeasible → 8.00 |  infeasible → 16.7 | infeasible → 1.17 | infeasible → 1383773 | infeasible → 4.99 | infeasible → 147.20 | infeasible → 40.02 | infeasible → 41.72 | infeasible → 1223.75 |
| 1000000 |          8 | workload |  infeasible → 8.00 |  infeasible → 58.3 | infeasible → 0.50 | infeasible → 1333317 | infeasible → 3.73 | infeasible → 143.51 | infeasible → 40.40 | infeasible → 39.13 | infeasible → 1357.30 |
| 1000000 |         16 | smallest | infeasible → 16.00 |  infeasible → 16.7 | infeasible → 1.17 | infeasible → 1383773 | infeasible → 4.38 | infeasible → 137.92 | infeasible → 39.58 | infeasible → 39.43 | infeasible → 1401.31 |
| 1000000 |         16 | workload | infeasible → 16.00 |  infeasible → 91.7 | infeasible → 0.08 |  infeasible → 250000 | infeasible → 3.01 | infeasible → 147.72 | infeasible → 38.32 | infeasible → 39.72 | infeasible → 1388.72 |
| 1000000 |         32 | smallest | infeasible → 32.00 |  infeasible → 25.0 | infeasible → 1.08 | infeasible → 1383463 | infeasible → 3.25 | infeasible → 143.08 | infeasible → 38.86 | infeasible → 39.08 | infeasible → 1258.47 |
| 1000000 |         32 | workload | infeasible → 32.00 | infeasible → 100.0 | infeasible → 0.00 |       infeasible → 0 | infeasible → 2.99 | infeasible → 141.19 | infeasible → 36.12 | infeasible → 39.82 | infeasible → 1482.81 |
| 1000000 |         48 | smallest |      48.00 → 48.00 |        16.7 → 25.0 |       1.17 → 1.08 |    1383773 → 1383463 |       4.44 → 4.43 |     125.43 → 143.31 |      35.99 → 39.48 |      41.71 → 39.99 |    1330.73 → 1340.70 |
| 1000000 |         48 | workload |      48.00 → 48.00 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       3.18 → 2.96 |     136.92 → 142.06 |      33.28 → 37.06 |      41.01 → 39.39 |    1411.08 → 1404.42 |

Measured query failures: 0. Full per-query data and totals remain in results/results.json. The baseline format is 1; the new format is 2. A complete rebuild is required, and generations include the format version. Old bundles are deliberately rejected rather than interpreted using the new layout.

## Interpretation

Smaller mandatory tables create space for more postings at the same budget. The effect on read counts depends on the selection policy and query workload; smaller tables do not guarantee every query becomes local. Exhaustive scoring of very common terms remains the CPU bottleneck. Compression adds per-block header/bit decoding and one-time block checksums; use the measured CPU and tail latency rather than assuming that fewer bytes always means faster queries. Direct length reads preserve bounded memory and avoid decoding IDs for non-winning candidates.

See WORKERD.md for actual local Worker HTTP/startup measurements, RESOURCES.md for storage/cost estimates, and results/bundle-dry-run.txt for the largest deployment artifact. No Cloudflare deployment was performed.
