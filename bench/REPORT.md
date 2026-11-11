# Local benchmark report

Measured 2026-11-11T18:51:13.476Z on Apple M3, darwin/arm64, Node v26.7.0.

Index construction: Reused byte-verified indexes; build timings/RSS inherited from matching construction records, not remeasured. When indexes are reused, build throughput/timing/RSS are inherited baseline measurements; query timings and query-process RSS are newly measured, without the builder in that process. Do not compare the query-only peak to an older combined build+query process peak.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per configuration; it includes the builder only for fresh-build runs. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|Docs|MiB budget|Strategy|Build s|Docs/s|Bundle MiB|Storage MiB|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Peak RSS MiB|
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|10000|8|smallest|0.91|10944|3.08|3.85|100.0|0.00|0|0.24|3.61|2.27|126.84|
|10000|8|workload|0.92|10911|3.08|3.85|100.0|0.00|0|0.20|3.52|2.11|87.63|
|10000|16|smallest|0.91|10994|3.08|3.85|100.0|0.00|0|0.25|3.55|2.28|111.89|
|10000|16|workload|0.90|11151|3.08|3.85|100.0|0.00|0|0.25|3.55|2.28|110.67|
|10000|32|smallest|0.88|11405|3.08|3.85|100.0|0.00|0|0.24|3.60|2.26|111.31|
|10000|32|workload|0.88|11368|3.08|3.85|100.0|0.00|0|0.24|3.53|2.31|109.38|
|10000|48|smallest|0.89|11241|3.08|3.85|100.0|0.00|0|0.24|3.61|2.26|110.86|
|10000|48|workload|0.92|10860|3.08|3.85|100.0|0.00|0|0.30|3.61|2.44|110.14|
|100000|8|smallest|5.56|17978|8.00|29.67|25.0|1.33|145206|0.60|15.16|6.25|182.67|
|100000|8|workload|5.77|17340|8.00|29.67|100.0|0.00|0|0.50|15.34|7.02|174.11|
|100000|16|smallest|5.23|19130|16.00|29.67|83.3|0.25|78898|0.47|14.72|6.26|187.14|
|100000|16|workload|5.34|18742|16.00|29.67|100.0|0.00|0|0.45|13.71|6.23|190.38|
|100000|32|smallest|5.21|19195|21.74|29.67|100.0|0.00|0|0.48|14.52|5.93|169.36|
|100000|32|workload|5.13|19474|21.74|29.67|100.0|0.00|0|0.46|15.06|6.04|173.53|
|100000|48|smallest|5.81|17208|21.74|29.67|100.0|0.00|0|0.48|14.63|6.04|169.39|
|100000|48|workload|5.24|19086|21.74|29.67|100.0|0.00|0|0.49|15.30|6.05|172.63|
|1000000|8|smallest|70.85|14114|8.00|291.23|16.7|1.42|1455506|3.16|73.11|18.89|603.48|
|1000000|8|workload|70.85|14114|8.00|291.23|58.3|0.67|1402426|3.80|73.54|21.64|523.63|
|1000000|16|smallest|70.66|14152|16.00|291.23|16.7|1.42|1455506|3.12|73.45|21.33|617.63|
|1000000|16|workload|72.43|13807|16.00|291.23|91.7|0.08|263019|2.84|74.56|20.41|585.31|
|1000000|32|smallest|71.73|13942|32.00|291.23|25.0|1.33|1455183|3.62|73.19|21.22|673.77|
|1000000|32|workload|68.97|14499|32.00|291.23|100.0|0.00|0|2.83|73.97|18.97|620.80|
|1000000|48|smallest|67.35|14847|48.00|291.23|25.0|1.33|1455183|3.05|76.83|22.35|594.73|
|1000000|48|workload|67.81|14748|48.00|291.23|100.0|0.00|0|2.73|69.48|18.83|567.50|

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v4 retains compressed document blocks and separates frequencies from token positions, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and SPLIT-POSTINGS.md reports the v3/v4 comparison; the optimized v3 baseline is preserved in baseline-v3-optimized/. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
