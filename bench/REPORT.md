# Local benchmark report

Measured 2026-11-11T18:00:14.631Z on Apple M3, darwin/arm64, Node v26.7.0.

Index construction: Reused byte-verified indexes; build timings/RSS inherited from matching construction records, not remeasured. When indexes are reused, build throughput/timing/RSS are inherited baseline measurements; query timings and query-process RSS are newly measured, without the builder in that process. Do not compare the query-only peak to an older combined build+query process peak.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per configuration; it includes the builder only for fresh-build runs. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|Docs|MiB budget|Strategy|Build s|Docs/s|Bundle MiB|Storage MiB|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Peak RSS MiB|
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|10000|8|smallest|0.88|11395|3.06|3.83|100.0|0.00|0|0.21|4.01|2.18|98.75|
|10000|8|workload|0.90|11084|3.06|3.83|100.0|0.00|0|0.23|4.70|2.25|87.11|
|10000|16|smallest|0.87|11461|3.06|3.83|100.0|0.00|0|0.25|4.05|2.54|87.08|
|10000|16|workload|1.09|9196|3.06|3.83|100.0|0.00|0|0.25|4.06|2.62|87.06|
|10000|32|smallest|0.93|10712|3.06|3.83|100.0|0.00|0|0.29|4.27|2.27|84.14|
|10000|32|workload|0.87|11533|3.06|3.83|100.0|0.00|0|0.26|4.09|2.32|85.16|
|10000|48|smallest|0.87|11537|3.06|3.83|100.0|0.00|0|0.34|4.09|2.27|113.81|
|10000|48|workload|0.91|11033|3.06|3.83|100.0|0.00|0|0.25|4.36|2.67|89.08|
|100000|8|smallest|5.19|19261|8.00|29.16|25.0|1.08|138328|0.72|15.32|5.10|153.23|
|100000|8|workload|5.09|19645|8.00|29.16|100.0|0.00|0|0.60|15.69|5.64|165.59|
|100000|16|smallest|5.12|19521|16.00|29.16|83.3|0.25|75001|0.67|16.41|6.50|178.75|
|100000|16|workload|5.08|19698|16.00|29.16|100.0|0.00|0|0.61|17.28|5.68|177.78|
|100000|32|smallest|5.02|19929|21.23|29.16|100.0|0.00|0|0.57|15.97|5.65|151.97|
|100000|32|workload|5.02|19930|21.23|29.16|100.0|0.00|0|0.66|21.41|7.09|144.61|
|100000|48|smallest|5.06|19779|21.23|29.16|100.0|0.00|0|0.65|17.47|6.17|157.39|
|100000|48|workload|5.15|19436|21.23|29.16|100.0|0.00|0|0.66|17.56|5.98|146.27|
|1000000|8|smallest|71.45|13996|8.00|283.07|16.7|1.17|1383773|3.81|105.97|28.66|562.41|
|1000000|8|workload|76.06|13147|8.00|283.07|58.3|0.50|1333317|3.24|95.06|25.15|537.28|
|1000000|16|smallest|74.85|13360|16.00|283.07|16.7|1.17|1383773|3.60|98.21|27.64|619.16|
|1000000|16|workload|70.31|14222|16.00|283.07|91.7|0.08|250000|2.94|95.08|25.55|603.09|
|1000000|32|smallest|69.69|14349|32.00|283.07|25.0|1.08|1383463|3.12|95.37|26.19|515.38|
|1000000|32|workload|77.28|12940|32.00|283.07|100.0|0.00|0|3.35|92.09|24.54|500.89|
|1000000|48|smallest|67.37|14843|48.00|283.07|25.0|1.08|1383463|3.08|92.69|24.75|550.94|
|1000000|48|workload|70.80|14124|48.00|283.07|100.0|0.00|0|4.00|108.24|24.83|625.11|

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v4 retains compressed document blocks and separates frequencies from token positions, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and SPLIT-POSTINGS.md reports the v3/v4 comparison; the optimized v3 baseline is preserved in baseline-v3-optimized/. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
