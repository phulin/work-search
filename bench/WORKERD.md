# Local workerd measurements

Miniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare.

| Configuration       | Startup wall ms | HTTP P50 ms | HTTP P95 ms | Failed requests |
| ------------------- | --------------: | ----------: | ----------: | --------------: |
| 10000-8-smallest    |           166.6 |        1.77 |       10.75 |               0 |
| 100000-8-smallest   |            67.0 |        6.40 |       40.53 |               0 |
| 100000-8-workload   |            53.3 |        4.64 |       32.82 |               0 |
| 1000000-8-smallest  |            46.4 |       24.88 |      256.90 |               0 |
| 1000000-8-workload  |            67.8 |       25.33 |      255.25 |               0 |
| 1000000-16-smallest |            71.0 |       28.36 |      272.13 |               0 |
| 1000000-16-workload |            70.2 |       23.94 |      255.14 |               0 |
| 1000000-32-smallest |            92.3 |       24.76 |      273.45 |               0 |
| 1000000-32-workload |            82.9 |       24.16 |      251.83 |               0 |
| 1000000-48-smallest |           109.6 |       24.93 |      278.47 |               0 |
| 1000000-48-workload |           105.2 |       28.00 |      253.99 |               0 |

Raw response diagnostics and exact samples are in results/workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.
