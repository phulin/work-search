# Local workerd with pruning and cache

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare. Cache capacity 4 MiB, total=false; pass zero is cold and later passes are warm.

|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|
|---|---:|---:|---:|---:|
|next-7r-8|159.7|41.51|65.55|0|
|next-7r-16|69.8|18.19|56.23|0|
|next-7r-32|97.5|18.27|53.33|0|
|next-7r-48|115.3|18.37|51.59|0|

Raw response diagnostics and exact samples are in results/next-workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
