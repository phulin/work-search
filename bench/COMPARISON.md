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
|   10000 |          8 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.21 |         5.80 → 4.09 |        2.39 → 2.60 |        0.50 → 0.52 |      239.63 → 223.80 |
|   10000 |          8 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.17 → 0.24 |         4.18 → 3.92 |        2.26 → 2.54 |        0.50 → 0.56 |      227.19 → 223.73 |
|   10000 |         16 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.21 |         4.19 → 4.31 |        2.31 → 2.60 |        0.50 → 0.59 |      226.73 → 225.06 |
|   10000 |         16 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.22 |         4.18 → 4.43 |        2.21 → 2.83 |        0.52 → 0.61 |      226.48 → 226.41 |
|   10000 |         32 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.16 → 0.21 |         4.20 → 4.23 |        2.22 → 2.43 |        0.50 → 0.52 |      226.91 → 224.88 |
|   10000 |         32 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.15 → 0.20 |         4.21 → 3.85 |        2.33 → 2.47 |        0.50 → 0.53 |      226.69 → 223.84 |
|   10000 |         48 | smallest |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.14 → 0.23 |         5.63 → 3.84 |        2.28 → 2.44 |        0.50 → 0.52 |      226.77 → 223.95 |
|   10000 |         48 | workload |        2.53 → 2.28 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.16 → 0.21 |         4.13 → 4.21 |        2.20 → 2.54 |        0.51 → 0.54 |      226.84 → 223.84 |
|  100000 |          8 | smallest |        8.00 → 8.00 |        25.0 → 25.0 |       1.08 → 1.08 |      138328 → 138328 |       0.76 → 0.79 |       20.42 → 21.65 |        7.63 → 7.91 |        3.15 → 3.30 |      390.94 → 451.94 |
|  100000 |          8 | workload |        8.00 → 8.00 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.53 → 0.63 |       21.34 → 20.52 |        7.13 → 7.68 |        3.31 → 3.26 |      393.42 → 441.00 |
|  100000 |         16 | smallest |      16.00 → 15.84 |        50.0 → 91.7 |       0.67 → 0.17 |       137339 → 50001 |       0.74 → 0.82 |       25.68 → 28.00 |        8.49 → 9.30 |        3.11 → 3.44 |      405.08 → 448.89 |
|  100000 |         16 | workload |      16.00 → 15.97 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.65 |       20.59 → 22.06 |        7.11 → 7.99 |        3.08 → 3.55 |      438.78 → 456.56 |
|  100000 |         32 | smallest |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.65 |       21.72 → 21.58 |        7.24 → 7.86 |        3.11 → 3.39 |      416.28 → 441.39 |
|  100000 |         32 | workload |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.54 → 0.77 |       21.27 → 21.95 |        7.25 → 8.30 |        3.11 → 3.49 |      452.58 → 460.36 |
|  100000 |         48 | smallest |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.64 |       21.28 → 21.23 |        7.16 → 7.66 |        3.12 → 3.42 |      409.42 → 393.06 |
|  100000 |         48 | workload |      18.95 → 16.41 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       0.52 → 0.64 |       21.00 → 29.05 |        7.11 → 8.51 |        3.11 → 3.38 |      401.84 → 423.70 |
| 1000000 |          8 | smallest |  infeasible → 8.00 |  infeasible → 16.7 | infeasible → 1.17 | infeasible → 1383773 | infeasible → 5.41 | infeasible → 135.33 | infeasible → 39.80 | infeasible → 44.61 | infeasible → 1347.41 |
| 1000000 |          8 | workload |  infeasible → 8.00 |  infeasible → 58.3 | infeasible → 0.50 | infeasible → 1333317 | infeasible → 3.57 | infeasible → 128.44 | infeasible → 35.14 | infeasible → 46.17 | infeasible → 1218.41 |
| 1000000 |         16 | smallest | infeasible → 16.00 |  infeasible → 16.7 | infeasible → 1.17 | infeasible → 1383773 | infeasible → 4.37 | infeasible → 128.80 | infeasible → 35.92 | infeasible → 44.96 | infeasible → 1235.64 |
| 1000000 |         16 | workload | infeasible → 16.00 |  infeasible → 91.7 | infeasible → 0.08 |  infeasible → 250000 | infeasible → 3.63 | infeasible → 129.59 | infeasible → 35.35 | infeasible → 43.68 | infeasible → 1320.81 |
| 1000000 |         32 | smallest | infeasible → 32.00 |  infeasible → 25.0 | infeasible → 1.08 | infeasible → 1383463 | infeasible → 4.40 | infeasible → 143.38 | infeasible → 36.93 | infeasible → 42.48 | infeasible → 1282.53 |
| 1000000 |         32 | workload | infeasible → 32.00 | infeasible → 100.0 | infeasible → 0.00 |       infeasible → 0 | infeasible → 3.60 | infeasible → 119.78 | infeasible → 30.96 | infeasible → 40.69 | infeasible → 1257.77 |
| 1000000 |         48 | smallest |      48.00 → 48.00 |        16.7 → 25.0 |       1.17 → 1.08 |    1383773 → 1383463 |       4.44 → 5.64 |     125.43 → 126.27 |      35.99 → 37.54 |      41.71 → 40.23 |    1330.73 → 1246.39 |
| 1000000 |         48 | workload |      48.00 → 48.00 |      100.0 → 100.0 |       0.00 → 0.00 |                0 → 0 |       3.18 → 3.08 |     136.92 → 132.65 |      33.28 → 31.96 |      41.01 → 40.37 |    1411.08 → 1216.47 |

Measured query failures: 0. Full per-query data and totals remain in results/results.json. The baseline format is 1; the new format is 2. A complete rebuild is required, and generations include the format version. Old bundles are deliberately rejected rather than interpreted using the new layout.

## Interpretation

Smaller mandatory tables create space for more postings at the same budget. The effect on read counts depends on the selection policy and query workload; smaller tables do not guarantee every query becomes local. Exhaustive scoring of very common terms remains the CPU bottleneck. Compression adds per-block header/bit decoding and one-time block checksums; use the measured CPU and tail latency rather than assuming that fewer bytes always means faster queries. Direct length reads preserve bounded memory and avoid decoding IDs for non-winning candidates.

See WORKERD.md for actual local Worker HTTP/startup measurements, RESOURCES.md for storage/cost estimates, and results/bundle-dry-run.txt for the largest deployment artifact. No Cloudflare deployment was performed.
