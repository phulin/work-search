# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|
|---|---:|---:|---:|---:|
|10000-8-smallest|148.5|1.62|9.12|0|
|100000-8-smallest|49.2|5.11|27.70|0|
|100000-8-workload|44.2|4.76|26.69|0|
|1000000-8-smallest|46.2|28.02|234.94|0|
|1000000-8-workload|59.7|23.85|211.17|0|
|1000000-16-smallest|71.8|22.51|240.73|0|
|1000000-16-workload|63.9|35.36|210.97|0|
|1000000-32-smallest|106.1|37.87|210.58|0|
|1000000-32-workload|90.9|21.67|211.00|0|
|1000000-48-smallest|139.3|36.13|210.87|0|
|1000000-48-workload|174.1|22.57|211.58|0|

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
