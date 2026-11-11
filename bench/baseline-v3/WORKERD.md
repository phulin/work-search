# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

| Configuration       | Startup wall ms | HTTP P50 ms | HTTP P95 ms | Failed requests |
| ------------------- | --------------: | ----------: | ----------: | --------------: |
| 10000-8-smallest    |            55.5 |        2.37 |       12.08 |               0 |
| 100000-8-smallest   |            51.3 |        5.89 |       64.38 |               0 |
| 100000-8-workload   |            48.3 |        5.01 |       63.67 |               0 |
| 1000000-8-smallest  |            45.7 |       40.88 |      560.57 |               0 |
| 1000000-8-workload  |            54.3 |       41.67 |      556.77 |               0 |
| 1000000-16-smallest |            70.5 |       45.69 |      546.91 |               0 |
| 1000000-16-workload |            70.2 |       39.14 |      593.84 |               0 |
| 1000000-32-smallest |           103.2 |       46.60 |      554.18 |               0 |
| 1000000-32-workload |            95.0 |       40.20 |      541.13 |               0 |
| 1000000-48-smallest |           114.1 |       40.69 |      554.01 |               0 |
| 1000000-48-workload |           112.2 |       43.58 |      548.43 |               0 |

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
