# Local benchmark report

Measured 2026-11-11T18:18:44.393Z on Apple M3, darwin/arm64, Node v26.7.0.

Index construction: Reused byte-verified indexes; build timings/RSS inherited from matching construction records, not remeasured. When indexes are reused, build throughput/timing/RSS are inherited baseline measurements; query timings and query-process RSS are newly measured, without the builder in that process. Do not compare the query-only peak to an older combined build+query process peak.

Deterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. 12 queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.

Latency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per configuration; it includes the builder only for fresh-build runs. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.

|Docs|MiB budget|Strategy|Build s|Docs/s|Bundle MiB|Storage MiB|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Peak RSS MiB|
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|10000|8|smallest|0.91|10944|3.08|3.85|100.0|0.00|0|0.27|3.96|2.29|118.33|
|10000|8|workload|0.92|10911|3.08|3.85|100.0|0.00|0|0.26|5.79|2.69|87.75|
|10000|16|smallest|0.91|10994|3.08|3.85|100.0|0.00|0|0.24|3.95|2.17|120.53|
|10000|16|workload|0.90|11151|3.08|3.85|100.0|0.00|0|0.19|4.04|2.09|86.38|
|10000|32|smallest|0.88|11405|3.08|3.85|100.0|0.00|0|0.23|3.98|2.15|118.33|
|10000|32|workload|0.88|11368|3.08|3.85|100.0|0.00|0|0.23|3.89|2.17|118.19|
|10000|48|smallest|0.89|11241|3.08|3.85|100.0|0.00|0|0.39|6.60|2.59|114.36|
|10000|48|workload|0.92|10860|3.08|3.85|100.0|0.00|0|0.33|7.07|2.85|111.83|
|100000|8|smallest|5.56|17978|8.00|29.67|25.0|1.33|145206|0.85|17.42|7.52|163.45|
|100000|8|workload|5.77|17340|8.00|29.67|100.0|0.00|0|0.78|23.07|7.77|182.59|
|100000|16|smallest|5.23|19130|16.00|29.67|83.3|0.25|78898|0.73|16.33|6.13|159.80|
|100000|16|workload|5.34|18742|16.00|29.67|100.0|0.00|0|0.72|17.67|6.52|177.94|
|100000|32|smallest|5.21|19195|21.74|29.67|100.0|0.00|0|0.64|16.45|5.61|189.17|
|100000|32|workload|5.13|19474|21.74|29.67|100.0|0.00|0|0.72|17.00|6.36|178.41|
|100000|48|smallest|5.81|17208|21.74|29.67|100.0|0.00|0|0.74|18.10|6.23|188.61|
|100000|48|workload|5.24|19086|21.74|29.67|100.0|0.00|0|0.67|15.35|5.47|159.58|
|1000000|8|smallest|70.85|14114|8.00|291.23|16.7|1.42|1455506|3.77|97.24|28.97|561.17|
|1000000|8|workload|70.85|14114|8.00|291.23|58.3|0.67|1402426|3.93|97.51|28.82|547.91|
|1000000|16|smallest|70.66|14152|16.00|291.23|16.7|1.42|1455506|3.91|101.20|28.70|561.70|
|1000000|16|workload|72.43|13807|16.00|291.23|91.7|0.08|263019|3.54|95.52|26.13|569.52|
|1000000|32|smallest|71.73|13942|32.00|291.23|25.0|1.33|1455183|3.67|99.31|29.91|586.67|
|1000000|32|workload|68.97|14499|32.00|291.23|100.0|0.00|0|3.50|96.89|26.05|623.25|
|1000000|48|smallest|67.35|14847|48.00|291.23|25.0|1.33|1455183|3.74|97.52|27.49|616.45|
|1000000|48|workload|67.81|14748|48.00|291.23|100.0|0.00|0|3.46|94.27|23.65|579.13|

## Interpretation and costs

The 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. Format v4 retains compressed document blocks and separates frequencies from token positions, making all requested budgets feasible for the million-document synthetic corpus. The original v1 measurements are preserved in baseline-v1/ and SPLIT-POSTINGS.md reports the v3/v4 comparison; the optimized v3 baseline is preserved in baseline-v3-optimized/. Different corpora may still exceed the minimum budget. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.

R2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

No Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.
