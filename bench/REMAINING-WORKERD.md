# Local workerd with pruning and cache

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare. Cache capacity 4 MiB, total=false; pass zero is cold and later passes are warm.

|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|
|---|---:|---:|---:|---:|
|100000-8-workload|156.5|2.73|15.80|0|
|1000000-8-workload|53.4|14.32|69.77|0|
|1000000-16-workload|66.6|13.08|63.76|0|
|1000000-32-workload|100.3|13.63|64.51|0|
|1000000-48-workload|188.4|12.89|68.70|0|

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
