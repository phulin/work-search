# Local benchmark report

Measured 2026-11-11T13:25:40.763Z on Apple M3, darwin/arm64, Node v26.7.0.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per build/configuration and includes Node and the builder. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|    Docs | MiB budget | Strategy |                                    Build s | Docs/s | Bundle MiB | Storage MiB | Zero reads % | Reads/query | Bytes/query | P50 ms | P95 ms | CPU ms/query | Peak RSS MiB |
| ------: | ---------: | -------- | -----------------------------------------: | -----: | ---------: | ----------: | -----------: | ----------: | ----------: | -----: | -----: | -----------: | -----------: |
|   10000 |          8 | smallest |                                       0.50 |  19836 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.15 |   5.80 |         2.39 |       239.63 |
|   10000 |          8 | workload |                                       0.50 |  20056 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.17 |   4.18 |         2.26 |       227.19 |
|   10000 |         16 | smallest |                                       0.50 |  19849 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.15 |   4.19 |         2.31 |       226.73 |
|   10000 |         16 | workload |                                       0.52 |  19384 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.15 |   4.18 |         2.21 |       226.48 |
|   10000 |         32 | smallest |                                       0.50 |  20056 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.16 |   4.20 |         2.22 |       226.91 |
|   10000 |         32 | workload |                                       0.50 |  19890 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.15 |   4.21 |         2.33 |       226.69 |
|   10000 |         48 | smallest |                                       0.50 |  19957 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.14 |   5.63 |         2.28 |       226.77 |
|   10000 |         48 | workload |                                       0.51 |  19471 |       2.53 |        3.31 |        100.0 |        0.00 |           0 |   0.16 |   4.13 |         2.20 |       226.84 |
|  100000 |          8 | smallest |                                       3.15 |  31762 |       8.00 |       26.88 |         25.0 |        1.08 |      138328 |   0.76 |  20.42 |         7.63 |       390.94 |
|  100000 |          8 | workload |                                       3.31 |  30251 |       8.00 |       26.88 |        100.0 |        0.00 |           0 |   0.53 |  21.34 |         7.13 |       393.42 |
|  100000 |         16 | smallest |                                       3.11 |  32128 |      16.00 |       26.88 |         50.0 |        0.67 |      137339 |   0.74 |  25.68 |         8.49 |       405.08 |
|  100000 |         16 | workload |                                       3.08 |  32455 |      16.00 |       26.88 |        100.0 |        0.00 |           0 |   0.52 |  20.59 |         7.11 |       438.78 |
|  100000 |         32 | smallest |                                       3.11 |  32152 |      18.95 |       26.88 |        100.0 |        0.00 |           0 |   0.52 |  21.72 |         7.24 |       416.28 |
|  100000 |         32 | workload |                                       3.11 |  32151 |      18.95 |       26.88 |        100.0 |        0.00 |           0 |   0.54 |  21.27 |         7.25 |       452.58 |
|  100000 |         48 | smallest |                                       3.12 |  32062 |      18.95 |       26.88 |        100.0 |        0.00 |           0 |   0.52 |  21.28 |         7.16 |       409.42 |
|  100000 |         48 | workload |                                       3.11 |  32152 |      18.95 |       26.88 |        100.0 |        0.00 |           0 |   0.52 |  21.00 |         7.11 |       401.84 |
| 1000000 |          8 | smallest | infeasible: mandatory tables exceed budget |        |            |             |              |             |             |        |        |              |
| 1000000 |          8 | workload | infeasible: mandatory tables exceed budget |        |            |             |              |             |             |        |        |              |
| 1000000 |         16 | smallest | infeasible: mandatory tables exceed budget |        |            |             |              |             |             |        |        |              |
| 1000000 |         16 | workload | infeasible: mandatory tables exceed budget |        |            |             |              |             |             |        |        |              |
| 1000000 |         32 | smallest | infeasible: mandatory tables exceed budget |        |            |             |              |             |             |        |        |              |
| 1000000 |         32 | workload | infeasible: mandatory tables exceed budget |        |            |             |              |             |             |        |        |              |
| 1000000 |         48 | smallest |                                      41.71 |  23972 |      48.00 |      264.25 |         16.7 |        1.17 |     1383773 |   4.44 | 125.43 |        35.99 |      1330.73 |
| 1000000 |         48 | workload |                                      41.01 |  24386 |      48.00 |      264.25 |        100.0 |        0.00 |           0 |   3.18 | 136.92 |        33.28 |      1411.08 |

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. At larger sizes, mandatory external IDs and document lengths consume meaningful space before embedding any postings. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
