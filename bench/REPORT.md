# Local benchmark report

Measured 2026-11-11T16:51:56.378Z on Apple M3, darwin/arm64, Node v26.7.0.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per build/configuration and includes Node and the builder. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|    Docs | MiB budget | Strategy | Build s | Docs/s | Bundle MiB | Storage MiB | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Peak RSS MiB |
| ------: | ---------: | -------- | ------: | -----: | ---------: | ----------: | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -----------: |
|   10000 |          8 | smallest |    0.69 |  14393 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   4.69 |         3.07 |       358.45 |
|   10000 |          8 | workload |    0.69 |  14389 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   4.87 |         3.25 |       341.05 |
|   10000 |         16 | smallest |    0.71 |  14030 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.21 |   4.73 |         3.17 |       340.56 |
|   10000 |         16 | workload |    0.71 |  14137 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.26 |   4.71 |         3.16 |       342.33 |
|   10000 |         32 | smallest |    0.69 |  14470 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.22 |   4.74 |         3.27 |       343.08 |
|   10000 |         32 | workload |    0.70 |  14386 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   4.76 |         3.16 |       343.52 |
|   10000 |         48 | smallest |    0.69 |  14482 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   4.71 |         3.00 |       343.66 |
|   10000 |         48 | workload |    0.69 |  14402 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.22 |   4.72 |         3.20 |       340.16 |
|  100000 |          8 | smallest |    4.92 |  20316 |       8.00 |       28.82 |         25.0 |        1.08 |      202272 |   0.87 |  26.93 |         9.14 |       653.55 |
|  100000 |          8 | workload |    5.03 |  19881 |       8.00 |       28.82 |        100.0 |        0.00 |           0 |   0.80 |  26.00 |         8.93 |       637.69 |
|  100000 |         16 | smallest |    4.87 |  20532 |      16.00 |       28.82 |         50.0 |        0.67 |      200717 |   0.89 |  32.67 |         8.32 |       612.64 |
|  100000 |         16 | workload |    4.82 |  20762 |      16.00 |       28.82 |        100.0 |        0.00 |           0 |   0.80 |  26.47 |         8.56 |       728.06 |
|  100000 |         32 | smallest |    4.83 |  20685 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.79 |  26.28 |         8.22 |       728.16 |
|  100000 |         32 | workload |    4.82 |  20727 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.80 |  26.32 |         8.16 |       692.09 |
|  100000 |         48 | smallest |    4.75 |  21067 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.79 |  26.33 |         8.80 |       710.14 |
|  100000 |         48 | workload |    4.81 |  20779 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.80 |  26.68 |         8.99 |       643.53 |
| 1000000 |          8 | smallest |   71.37 |  14011 |       8.00 |      282.72 |         16.7 |        1.17 |     2022124 |   6.52 | 200.63 |        49.26 |      1920.58 |
| 1000000 |          8 | workload |   74.56 |  13412 |       8.00 |      282.72 |         58.3 |        0.50 |     1951922 |   6.08 | 161.87 |        46.82 |      1640.89 |
| 1000000 |         16 | smallest |   69.64 |  14359 |      16.00 |      282.72 |         16.7 |        1.17 |     2022124 |   6.49 | 161.40 |        45.64 |      1533.80 |
| 1000000 |         16 | workload |   72.27 |  13836 |      16.00 |      282.72 |         91.7 |        0.17 |      666667 |   3.90 | 161.45 |        45.47 |      1764.98 |
| 1000000 |         32 | smallest |   71.06 |  14073 |      32.00 |      282.72 |         16.7 |        1.17 |     2022124 |   5.56 | 163.87 |        46.88 |      1627.77 |
| 1000000 |         32 | workload |   68.68 |  14561 |      32.00 |      282.72 |        100.0 |        0.00 |           0 |   3.74 | 154.67 |        43.36 |      1599.92 |
| 1000000 |         48 | smallest |   73.75 |  13559 |      48.00 |      282.72 |         25.0 |        1.08 |     2021735 |   5.66 | 164.52 |        46.51 |      1983.31 |
| 1000000 |         48 | workload |   69.23 |  14444 |      48.00 |      282.72 |        100.0 |        0.00 |           0 |   5.02 | 152.88 |        45.12 |      1713.88 |

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v3 retains compressed document blocks and adds token positions to postings, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and CONNECTORS.md reports the new syntax and positional-index tradeoffs. The v2 optimized baseline is preserved in baseline-v2-optimized/. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
