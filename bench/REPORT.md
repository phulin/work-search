# Local benchmark report

Measured 2026-11-11T17:34:57.663Z on Apple M3, darwin/arm64, Node v26.7.0.

Index construction: Fresh build. When indexes are reused, build throughput/timing/RSS are inherited baseline measurements; query timings and query-process RSS are newly measured, without the builder in that process. Do not compare the query-only peak to an older combined build+query process peak.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per configuration; it includes the builder only for fresh-build runs. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|    Docs | MiB budget | Strategy | Build s | Docs/s | Bundle MiB | Storage MiB | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Peak RSS MiB |
| ------: | ---------: | -------- | ------: | -----: | ---------: | ----------: | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -----------: |
|   10000 |          8 | smallest |    0.88 |  11395 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.23 |   4.17 |         2.74 |       366.25 |
|   10000 |          8 | workload |    0.90 |  11084 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.23 |   4.01 |         2.52 |       353.63 |
|   10000 |         16 | smallest |    0.87 |  11461 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.30 |   4.73 |         3.07 |       353.92 |
|   10000 |         16 | workload |    1.09 |   9196 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.30 |   4.75 |         2.97 |       299.41 |
|   10000 |         32 | smallest |    0.93 |  10712 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.23 |   4.17 |         2.65 |       353.45 |
|   10000 |         32 | workload |    0.87 |  11533 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.24 |   4.00 |         2.54 |       352.64 |
|   10000 |         48 | smallest |    0.87 |  11537 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.22 |   4.08 |         2.37 |       353.98 |
|   10000 |         48 | workload |    0.91 |  11033 |       3.06 |        3.83 |        100.0 |        0.00 |           0 |   0.24 |   4.07 |         2.67 |       353.45 |
|  100000 |          8 | smallest |    5.19 |  19261 |       8.00 |       29.16 |         25.0 |        1.08 |      138328 |   0.83 |  22.73 |         7.98 |       640.86 |
|  100000 |          8 | workload |    5.09 |  19645 |       8.00 |       29.16 |        100.0 |        0.00 |           0 |   0.62 |  25.59 |         7.24 |       587.80 |
|  100000 |         16 | smallest |    5.12 |  19521 |      16.00 |       29.16 |         83.3 |        0.25 |       75001 |   0.65 |  22.64 |         6.96 |       699.42 |
|  100000 |         16 | workload |    5.08 |  19698 |      16.00 |       29.16 |        100.0 |        0.00 |           0 |   0.64 |  21.96 |         7.05 |       611.19 |
|  100000 |         32 | smallest |    5.02 |  19929 |      21.23 |       29.16 |        100.0 |        0.00 |           0 |   0.66 |  21.81 |         7.20 |       631.02 |
|  100000 |         32 | workload |    5.02 |  19930 |      21.23 |       29.16 |        100.0 |        0.00 |           0 |   0.65 |  21.96 |         6.72 |       620.14 |
|  100000 |         48 | smallest |    5.06 |  19779 |      21.23 |       29.16 |        100.0 |        0.00 |           0 |   0.66 |  21.94 |         6.83 |       611.11 |
|  100000 |         48 | workload |    5.15 |  19436 |      21.23 |       29.16 |        100.0 |        0.00 |           0 |   0.64 |  22.06 |         6.75 |       629.80 |
| 1000000 |          8 | smallest |   71.45 |  13996 |       8.00 |      283.07 |         16.7 |        1.17 |     1383773 |   5.05 | 146.09 |        39.64 |      1624.53 |
| 1000000 |          8 | workload |   76.06 |  13147 |       8.00 |      283.07 |         58.3 |        0.50 |     1333317 |   3.17 | 138.92 |        40.40 |      1864.73 |
| 1000000 |         16 | smallest |   74.85 |  13360 |      16.00 |      283.07 |         16.7 |        1.17 |     1383773 |   5.09 | 149.41 |        39.67 |      1433.08 |
| 1000000 |         16 | workload |   70.31 |  14222 |      16.00 |      283.07 |         91.7 |        0.08 |      250000 |   7.71 | 213.42 |        45.38 |      1553.31 |
| 1000000 |         32 | smallest |   69.69 |  14349 |      32.00 |      283.07 |         25.0 |        1.08 |     1383463 |   4.48 | 136.45 |        36.93 |      1494.48 |
| 1000000 |         32 | workload |   77.28 |  12940 |      32.00 |      283.07 |        100.0 |        0.00 |           0 |   3.42 | 133.54 |        35.25 |      1607.61 |
| 1000000 |         48 | smallest |   67.37 |  14843 |      48.00 |      283.07 |         25.0 |        1.08 |     1383463 |   4.40 | 138.80 |        36.92 |      1587.08 |
| 1000000 |         48 | workload |   70.80 |  14124 |      48.00 |      283.07 |        100.0 |        0.00 |           0 |   3.69 | 136.94 |        35.79 |      1561.75 |

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v4 retains compressed document blocks and separates frequencies from token positions, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and SPLIT-POSTINGS.md reports the v3/v4 comparison; the optimized v3 baseline is preserved in baseline-v3-optimized/. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
