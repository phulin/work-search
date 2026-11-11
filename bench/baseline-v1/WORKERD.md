# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twelve HTTP queries per configuration (four types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

| Configuration       | Startup wall ms | HTTP P50 ms | HTTP P95 ms | Failed requests |
| ------------------- | --------------: | ----------: | ----------: | --------------: |
| 10000-8-smallest    |           107.2 |        4.51 |       27.68 |               0 |
| 100000-8-smallest   |           176.5 |        3.32 |       16.37 |               0 |
| 100000-8-workload   |            57.7 |        3.71 |       17.52 |               0 |
| 1000000-48-smallest |           236.2 |        7.14 |      102.33 |               0 |
| 1000000-48-workload |           123.7 |        5.62 |       83.61 |               0 |

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
