# Local benchmark report

Measured 2026-11-11T16:11:43.617Z on Apple M3, darwin/arm64, Node v26.7.0.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per build/configuration and includes Node and the builder. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|    Docs | MiB budget | Strategy | Build s | Docs/s | Bundle MiB | Storage MiB | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Peak RSS MiB |
| ------: | ---------: | -------- | ------: | -----: | ---------: | ----------: | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -----------: |
|   10000 |          8 | smallest |    0.52 |  19142 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.21 |   4.09 |         2.60 |       223.80 |
|   10000 |          8 | workload |    0.56 |  17949 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.24 |   3.92 |         2.54 |       223.73 |
|   10000 |         16 | smallest |    0.59 |  16869 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.21 |   4.31 |         2.60 |       225.06 |
|   10000 |         16 | workload |    0.61 |  16390 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.22 |   4.43 |         2.83 |       226.41 |
|   10000 |         32 | smallest |    0.52 |  19067 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.21 |   4.23 |         2.43 |       224.88 |
|   10000 |         32 | workload |    0.53 |  18974 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.20 |   3.85 |         2.47 |       223.84 |
|   10000 |         48 | smallest |    0.52 |  19361 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.23 |   3.84 |         2.44 |       223.95 |
|   10000 |         48 | workload |    0.54 |  18538 |       2.28 |        3.06 |        100.0 |        0.00 |           0 |   0.21 |   4.21 |         2.54 |       223.84 |
|  100000 |          8 | smallest |    3.30 |  30296 |       8.00 |       24.34 |         25.0 |        1.08 |      138328 |   0.79 |  21.65 |         7.91 |       451.94 |
|  100000 |          8 | workload |    3.26 |  30681 |       8.00 |       24.34 |        100.0 |        0.00 |           0 |   0.63 |  20.52 |         7.68 |       441.00 |
|  100000 |         16 | smallest |    3.44 |  29079 |      15.84 |       24.34 |         91.7 |        0.17 |       50001 |   0.82 |  28.00 |         9.30 |       448.89 |
|  100000 |         16 | workload |    3.55 |  28145 |      15.97 |       24.34 |        100.0 |        0.00 |           0 |   0.65 |  22.06 |         7.99 |       456.56 |
|  100000 |         32 | smallest |    3.39 |  29517 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.65 |  21.58 |         7.86 |       441.39 |
|  100000 |         32 | workload |    3.49 |  28682 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.77 |  21.95 |         8.30 |       460.36 |
|  100000 |         48 | smallest |    3.42 |  29217 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.64 |  21.23 |         7.66 |       393.06 |
|  100000 |         48 | workload |    3.38 |  29589 |      16.41 |       24.34 |        100.0 |        0.00 |           0 |   0.64 |  29.05 |         8.51 |       423.70 |
| 1000000 |          8 | smallest |   44.61 |  22417 |       8.00 |      237.90 |         16.7 |        1.17 |     1383773 |   5.41 | 135.33 |        39.80 |      1347.41 |
| 1000000 |          8 | workload |   46.17 |  21659 |       8.00 |      237.90 |         58.3 |        0.50 |     1333317 |   3.57 | 128.44 |        35.14 |      1218.41 |
| 1000000 |         16 | smallest |   44.96 |  22242 |      16.00 |      237.90 |         16.7 |        1.17 |     1383773 |   4.37 | 128.80 |        35.92 |      1235.64 |
| 1000000 |         16 | workload |   43.68 |  22893 |      16.00 |      237.90 |         91.7 |        0.08 |      250000 |   3.63 | 129.59 |        35.35 |      1320.81 |
| 1000000 |         32 | smallest |   42.48 |  23538 |      32.00 |      237.90 |         25.0 |        1.08 |     1383463 |   4.40 | 143.38 |        36.93 |      1282.53 |
| 1000000 |         32 | workload |   40.69 |  24575 |      32.00 |      237.90 |        100.0 |        0.00 |           0 |   3.60 | 119.78 |        30.96 |      1257.77 |
| 1000000 |         48 | smallest |   40.23 |  24859 |      48.00 |      237.90 |         25.0 |        1.08 |     1383463 |   5.64 | 126.27 |        37.54 |      1246.39 |
| 1000000 |         48 | workload |   40.37 |  24773 |      48.00 |      237.90 |        100.0 |        0.00 |           0 |   3.08 | 132.65 |        31.96 |      1216.47 |

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v2 uses compressed restart blocks for mandatory document data, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and COMPARISON.md reports the changes. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
