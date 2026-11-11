# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twelve HTTP queries per configuration (four types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

| Configuration       | Startup wall ms | HTTP P50 ms | HTTP P95 ms | Failed requests |
| ------------------- | --------------: | ----------: | ----------: | --------------: |
| 10000-8-smallest    |            54.2 |        1.14 |       13.56 |               0 |
| 100000-8-smallest   |            48.5 |        2.65 |       19.52 |               0 |
| 100000-8-workload   |            45.0 |        1.51 |       18.84 |               0 |
| 1000000-8-smallest  |            44.8 |        5.49 |      120.85 |               0 |
| 1000000-8-workload  |            50.4 |        5.07 |      119.98 |               0 |
| 1000000-16-smallest |            65.9 |        5.82 |      121.71 |               0 |
| 1000000-16-workload |            68.9 |        5.10 |      119.87 |               0 |
| 1000000-32-smallest |            92.9 |        5.76 |      120.30 |               0 |
| 1000000-32-workload |            84.7 |        5.09 |      120.60 |               0 |
| 1000000-48-smallest |           117.9 |        5.72 |      121.40 |               0 |
| 1000000-48-workload |           105.4 |        5.01 |      119.04 |               0 |

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
