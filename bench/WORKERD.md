# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|
|---|---:|---:|---:|---:|
|10000-8-smallest|151.0|1.54|8.60|0|
|100000-8-smallest|49.9|3.53|29.30|0|
|100000-8-workload|44.1|2.21|23.32|0|
|1000000-8-smallest|46.7|11.24|188.02|0|
|1000000-8-workload|59.6|12.00|184.12|0|
|1000000-16-smallest|72.3|15.95|213.05|0|
|1000000-16-workload|87.1|10.39|181.45|0|
|1000000-32-smallest|91.2|11.79|184.64|0|
|1000000-32-workload|95.6|9.87|188.45|0|
|1000000-48-smallest|119.9|11.40|188.46|0|
|1000000-48-workload|129.5|10.72|219.69|0|

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
