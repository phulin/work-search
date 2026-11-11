# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|
|---|---:|---:|---:|---:|
|10000-8-smallest|148.6|1.68|9.03|0|
|100000-8-smallest|50.1|4.18|26.64|0|
|100000-8-workload|44.9|2.73|26.12|0|
|1000000-8-smallest|45.6|12.36|212.89|0|
|1000000-8-workload|57.8|12.49|219.56|0|
|1000000-16-smallest|68.0|15.74|217.93|0|
|1000000-16-workload|69.9|10.14|213.00|0|
|1000000-32-smallest|91.7|12.94|215.69|0|
|1000000-32-workload|87.2|9.93|209.70|0|
|1000000-48-smallest|112.9|12.76|214.18|0|
|1000000-48-workload|110.2|9.64|216.35|0|

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
