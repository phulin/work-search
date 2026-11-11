# Resource and cost detail

These use the same measured builds as REPORT.md. Binary-view construction is a warm Node microbenchmark; it excludes disk reads, process startup, and module evaluation. Build RSS and build throughput may be inherited from the baseline when immutable indexes are reused; they are not new construction measurements. RSS is the original peak for the entire offline build/query child process, **not Worker isolate memory**. Worker memory was not measured on Cloudflare.

|Docs|Budget MiB|Policy|Dictionary KiB|Document table MiB|Uncompressed table MiB|Postings MiB|Embedded MiB|Remote objects MiB|View construction ms|Build peak RSS MiB|R2 storage/month USD|R2 reads/1M queries USD|
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|10000|8|smallest|951.1|0.06|0.30|2.09|2.09|0.78|0.0020|352.8|0.00001|0.000|
|10000|8|workload|951.1|0.06|0.30|2.09|2.09|0.78|0.0018|334.9|0.00001|0.000|
|10000|16|smallest|951.1|0.06|0.30|2.09|2.09|0.78|0.0018|335.1|0.00001|0.000|
|10000|16|workload|951.1|0.06|0.30|2.09|2.09|0.78|0.0026|339.1|0.00001|0.000|
|10000|32|smallest|951.1|0.06|0.30|2.09|2.09|0.78|0.0026|336.9|0.00001|0.000|
|10000|32|workload|951.1|0.06|0.30|2.09|2.09|0.78|0.0020|336.6|0.00001|0.000|
|10000|48|smallest|951.1|0.06|0.30|2.09|2.09|0.78|0.0027|337.0|0.00001|0.000|
|10000|48|workload|951.1|0.06|0.30|2.09|2.09|0.78|0.0020|337.7|0.00001|0.000|
|100000|8|smallest|951.4|0.59|3.14|20.21|6.48|21.67|0.0023|791.2|0.00034|0.480|
|100000|8|workload|951.4|0.59|3.14|20.21|6.48|21.67|0.0038|600.9|0.00034|0.000|
|100000|16|smallest|951.4|0.59|3.14|20.21|14.48|13.67|0.0022|594.6|0.00021|0.090|
|100000|16|workload|951.4|0.59|3.14|20.21|14.48|13.67|0.0041|593.8|0.00021|0.000|
|100000|32|smallest|951.4|0.59|3.14|20.21|20.21|7.93|0.0043|604.7|0.00012|0.000|
|100000|32|workload|951.4|0.59|3.14|20.21|20.21|7.93|0.0022|594.6|0.00012|0.000|
|100000|48|smallest|951.4|0.59|3.14|20.21|20.21|7.93|0.0038|603.0|0.00012|0.000|
|100000|48|workload|951.4|0.59|3.14|20.21|20.21|7.93|0.0021|612.8|0.00012|0.000|
|1000000|8|smallest|951.4|5.97|32.32|204.10|1.10|283.23|0.0153|1497.0|0.00445|0.510|
|1000000|8|workload|951.4|5.97|32.32|204.10|1.10|283.23|0.0023|1486.6|0.00445|0.240|
|1000000|16|smallest|951.4|5.97|32.32|204.10|9.10|275.23|0.0177|1473.2|0.00433|0.510|
|1000000|16|workload|951.4|5.97|32.32|204.10|9.10|275.23|0.0025|1367.7|0.00433|0.030|
|1000000|32|smallest|951.4|5.97|32.32|204.10|25.10|259.23|0.0024|1422.5|0.00408|0.480|
|1000000|32|workload|951.4|5.97|32.32|204.10|25.10|259.23|0.0028|1586.7|0.00408|0.000|
|1000000|48|smallest|951.4|5.97|32.32|204.10|41.10|243.23|0.0025|1776.9|0.00383|0.480|
|1000000|48|workload|951.4|5.97|32.32|204.10|41.10|243.23|0.0023|1178.1|0.00383|0.000|

Cost estimates exclude free tiers, Workers request/CPU charges, metadata-query reads, retries, and build/deployment operations. R2 objects include packed metadata even though the measured searches request only IDs. One full reupload costs object count / 1e6 × $4.50 in Class A writes, plus HEAD reads; repeat verified uploads skip PUTs. These small storage estimates do not mean total hosting is free: Workers Paid has a $5 monthly minimum and CPU usage matters for common terms. Pricing sources: [R2](https://developers.cloudflare.com/r2/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/).

This is an initial synthetic baseline: twelve fixed query types, three passes per configuration, one deterministic corpus seed, no real-world corpus supplied. Tail percentiles have limited statistical confidence. Workload-aware selection uses the test queries as training input; validate generalization with independent traffic before choosing a production policy. No measured query failures occurred.
