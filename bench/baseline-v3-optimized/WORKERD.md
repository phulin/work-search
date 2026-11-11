# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

| Configuration       | Startup wall ms | HTTP P50 ms | HTTP P95 ms | Failed requests |
| ------------------- | --------------: | ----------: | ----------: | --------------: |
| 10000-8-smallest    |           143.4 |        1.75 |        6.42 |               0 |
| 100000-8-smallest   |            48.9 |        5.32 |       37.10 |               0 |
| 100000-8-workload   |            47.6 |        4.37 |       30.27 |               0 |
| 1000000-8-smallest  |            44.0 |       39.98 |      253.86 |               0 |
| 1000000-8-workload  |            60.9 |       39.49 |      253.66 |               0 |
| 1000000-16-smallest |            68.4 |       39.05 |      249.77 |               0 |
| 1000000-16-workload |            68.2 |       36.79 |      258.73 |               0 |
| 1000000-32-smallest |            98.3 |       38.60 |      255.27 |               0 |
| 1000000-32-workload |            91.5 |       37.27 |      246.72 |               0 |
| 1000000-48-smallest |           110.3 |       40.59 |      264.44 |               0 |
| 1000000-48-workload |           122.8 |       37.69 |      254.90 |               0 |

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
