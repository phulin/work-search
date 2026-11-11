# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|
|---|---:|---:|---:|---:|
|10000-8-smallest|145.5|1.43|7.37|0|
|100000-8-smallest|48.9|3.46|23.22|0|
|100000-8-workload|49.4|2.48|23.08|0|
|1000000-8-smallest|46.0|15.39|181.04|0|
|1000000-8-workload|60.0|13.80|184.66|0|
|1000000-16-smallest|67.7|14.13|179.90|0|
|1000000-16-workload|74.5|12.11|184.45|0|
|1000000-32-smallest|96.7|14.11|178.91|0|
|1000000-32-workload|89.3|11.50|179.03|0|
|1000000-48-smallest|108.3|13.93|178.72|0|
|1000000-48-workload|104.3|11.49|184.19|0|

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
