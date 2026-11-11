# Local benchmark report

Measured 2026-11-11T15:55:22.389Z on Apple M3, darwin/arm64, Node v26.7.0.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per build/configuration and includes Node and the builder. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|    Docs | MiB budget | Strategy | Build s | Docs/s | Bundle MiB | Storage MiB | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Peak RSS MiB |
| ------: | ---------: | -------- | ------: | -----: | ---------: | ----------: | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -----------: |
|   10000 |          8 | smallest |    0.50 |  19943 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.19 |   4.44 |         2.62 |       234.63 |
|   10000 |          8 | workload |    0.52 |  19090 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.23 |   5.68 |         2.98 |       226.42 |
|   10000 |         16 | smallest |    0.53 |  18744 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.21 |   4.50 |         2.91 |       224.44 |
|   10000 |         16 | workload |    0.52 |  19233 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.23 |   4.36 |         2.74 |       226.20 |
|   10000 |         32 | smallest |    0.51 |  19494 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.20 |   4.34 |         2.66 |       224.02 |
|   10000 |         32 | workload |    0.52 |  19076 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.23 |   4.35 |         2.71 |       218.91 |
|   10000 |         48 | smallest |    0.50 |  19842 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.23 |   4.56 |         2.73 |       225.36 |
|   10000 |         48 | workload |    0.52 |  19200 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.21 |   6.09 |         2.95 |       225.42 |
|  100000 |          8 | smallest |    3.18 |  31448 |       8.00 |       24.34 |         25.0 |        1.08 |      138328 |   0.72 |  23.00 |         8.33 |       394.50 |
|  100000 |          8 | workload |    3.18 |  31478 |       8.00 |       24.34 |        100.0 |        0.00 |           0 |   0.63 |  22.97 |         8.10 |       468.13 |
|  100000 |         16 | smallest |    3.40 |  29379 |      15.84 |       24.34 |         91.7 |        0.17 |       50001 |   0.64 |  22.88 |         8.23 |       378.66 |
|  100000 |         16 | workload |    3.40 |  29430 |      15.97 |       24.34 |        100.0 |        0.00 |           0 |   0.62 |  21.84 |         7.89 |       407.22 |
|  100000 |         32 | smallest |    3.26 |  30659 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.63 |  21.83 |         7.83 |       427.38 |
|  100000 |         32 | workload |    3.28 |  30528 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.63 |  22.40 |         7.84 |       395.67 |
|  100000 |         48 | smallest |    3.14 |  31804 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.65 |  21.86 |         7.79 |       396.11 |
|  100000 |         48 | workload |    3.16 |  31650 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.63 |  22.12 |         7.83 |       424.73 |
| 1000000 |          8 | smallest |   41.72 |  23970 |       8.00 |      237.90 |         16.7 |        1.17 |     1383773 |   4.99 | 147.20 |        40.02 |      1223.75 |
| 1000000 |          8 | workload |   39.13 |  25557 |       8.00 |      237.90 |         58.3 |        0.50 |     1333317 |   3.73 | 143.51 |        40.40 |      1357.30 |
| 1000000 |         16 | smallest |   39.43 |  25363 |      16.00 |      237.90 |         16.7 |        1.17 |     1383773 |   4.38 | 137.92 |        39.58 |      1401.31 |
| 1000000 |         16 | workload |   39.72 |  25175 |      16.00 |      237.90 |         91.7 |        0.08 |      250000 |   3.01 | 147.72 |        38.32 |      1388.72 |
| 1000000 |         32 | smallest |   39.08 |  25589 |      32.00 |      237.90 |         25.0 |        1.08 |     1383463 |   3.25 | 143.08 |        38.86 |      1258.47 |
| 1000000 |         32 | workload |   39.82 |  25114 |      32.00 |      237.90 |        100.0 |        0.00 |           0 |   2.99 | 141.19 |        36.12 |      1482.81 |
| 1000000 |         48 | smallest |   39.99 |  25009 |      48.00 |      237.90 |         25.0 |        1.08 |     1383463 |   4.43 | 143.31 |        39.48 |      1340.70 |
| 1000000 |         48 | workload |   39.39 |  25386 |      48.00 |      237.90 |        100.0 |        0.00 |           0 |   2.96 | 142.06 |        37.06 |      1404.42 |

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v2 uses compressed restart blocks for mandatory document data, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and COMPARISON.md reports the changes. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
