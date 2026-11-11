# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twelve HTTP queries per configuration (four types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

| Configuration       | Startup wall ms | HTTP P50 ms | HTTP P95 ms | Failed requests |
| ------------------- | --------------: | ----------: | ----------: | --------------: |
| 10000-8-smallest    |           152.2 |        1.27 |       14.31 |               0 |
| 100000-8-smallest   |            51.6 |        3.14 |       19.11 |               0 |
| 100000-8-workload   |            48.0 |        1.86 |       20.44 |               0 |
| 1000000-8-smallest  |            48.1 |        6.43 |      110.99 |               0 |
| 1000000-8-workload  |            63.9 |        5.68 |      112.39 |               0 |
| 1000000-16-smallest |            78.0 |        6.26 |      110.78 |               0 |
| 1000000-16-workload |            66.2 |        5.86 |      138.96 |               0 |
| 1000000-32-smallest |           107.5 |        6.36 |      114.28 |               0 |
| 1000000-32-workload |            91.4 |        5.62 |      108.84 |               0 |
| 1000000-48-smallest |           116.7 |        6.32 |      110.41 |               0 |
| 1000000-48-workload |            99.6 |        5.61 |      140.93 |               0 |

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
