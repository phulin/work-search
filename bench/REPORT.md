# Local benchmark report

Measured 2026-11-11T17:07:18.487Z on Apple M3, darwin/arm64, Node v26.7.0.

Index construction: Reused byte-verified v3 indexes; build timings/RSS inherited from a68426a baseline, not remeasured. When indexes are reused, build throughput/timing/RSS are inherited baseline measurements; query timings and query-process RSS are newly measured, without the builder in that process. Do not compare the query-only peak to an older combined build+query process peak.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per configuration; it includes the builder only for fresh-build runs. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|    Docs | MiB budget | Strategy | Build s | Docs/s | Bundle MiB | Storage MiB | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Peak RSS MiB |
| ------: | ---------: | -------- | ------: | -----: | ---------: | ----------: | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -----------: |
|   10000 |          8 | smallest |    0.69 |  14393 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.22 |   6.70 |         3.51 |       131.03 |
|   10000 |          8 | workload |    0.69 |  14389 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   5.10 |         3.28 |        88.75 |
|   10000 |         16 | smallest |    0.71 |  14030 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.22 |   4.99 |         3.47 |        88.27 |
|   10000 |         16 | workload |    0.71 |  14137 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.24 |   5.07 |         3.44 |        86.97 |
|   10000 |         32 | smallest |    0.69 |  14470 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.29 |   5.14 |         3.30 |        87.88 |
|   10000 |         32 | workload |    0.70 |  14386 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.24 |   5.02 |         3.42 |        88.41 |
|   10000 |         48 | smallest |    0.69 |  14482 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   5.10 |         3.06 |        88.48 |
|   10000 |         48 | workload |    0.69 |  14402 |       2.73 |        3.51 |        100.0 |        0.00 |           0 |   0.23 |   5.06 |         3.49 |        88.75 |
|  100000 |          8 | smallest |    4.92 |  20316 |       8.00 |       28.82 |         25.0 |        1.08 |      202272 |   1.04 |  27.06 |         9.95 |       172.20 |
|  100000 |          8 | workload |    5.03 |  19881 |       8.00 |       28.82 |        100.0 |        0.00 |           0 |   0.79 |  27.36 |         9.45 |       184.66 |
|  100000 |         16 | smallest |    4.87 |  20532 |      16.00 |       28.82 |         50.0 |        0.67 |      200717 |   0.91 |  27.01 |         9.64 |       171.56 |
|  100000 |         16 | workload |    4.82 |  20762 |      16.00 |       28.82 |        100.0 |        0.00 |           0 |   0.77 |  26.97 |         9.00 |       163.63 |
|  100000 |         32 | smallest |    4.83 |  20685 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.79 |  26.82 |         9.64 |       149.80 |
|  100000 |         32 | workload |    4.82 |  20727 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.77 |  26.68 |         9.67 |       149.38 |
|  100000 |         48 | smallest |    4.75 |  21067 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.80 |  26.93 |         9.59 |       148.63 |
|  100000 |         48 | workload |    4.81 |  20779 |      20.89 |       28.82 |        100.0 |        0.00 |           0 |   0.81 |  26.80 |         9.66 |       146.53 |
| 1000000 |          8 | smallest |   71.37 |  14011 |       8.00 |      282.72 |         16.7 |        1.17 |     2022124 |   4.11 | 167.30 |        44.60 |       640.75 |
| 1000000 |          8 | workload |   74.56 |  13412 |       8.00 |      282.72 |         58.3 |        0.50 |     1951922 |   4.49 | 164.71 |        46.01 |       577.25 |
| 1000000 |         16 | smallest |   69.64 |  14359 |      16.00 |      282.72 |         16.7 |        1.17 |     2022124 |   4.18 | 164.68 |        46.53 |       634.23 |
| 1000000 |         16 | workload |   72.27 |  13836 |      16.00 |      282.72 |         91.7 |        0.17 |      666667 |   3.92 | 162.35 |        43.80 |       569.77 |
| 1000000 |         32 | smallest |   71.06 |  14073 |      32.00 |      282.72 |         16.7 |        1.17 |     2022124 |   4.16 | 166.46 |        46.63 |       566.48 |
| 1000000 |         32 | workload |   68.68 |  14561 |      32.00 |      282.72 |        100.0 |        0.00 |           0 |   3.98 | 160.91 |        43.39 |       619.55 |
| 1000000 |         48 | smallest |   73.75 |  13559 |      48.00 |      282.72 |         25.0 |        1.08 |     2021735 |   4.13 | 164.04 |        45.44 |       596.47 |
| 1000000 |         48 | workload |   69.23 |  14444 |      48.00 |      282.72 |        100.0 |        0.00 |           0 |   3.97 | 161.38 |        43.37 |       596.19 |

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v3 retains compressed document blocks and adds token positions to postings, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and CONNECTORS.md reports the new syntax and positional-index tradeoffs. The v2 optimized baseline is preserved in baseline-v2-optimized/. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
