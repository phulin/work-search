# Resource and cost detail

These use the same measured builds as REPORT.md. Binary-view construction is a warm Node microbenchmark; it excludes disk reads, process startup, and module evaluation. RSS is the peak for the entire offline build/query child process, **not Worker isolate memory**. Worker memory was not measured on Cloudflare.

|    Docs | Budget MiB | Policy   | Dictionary KiB | Postings MiB | Embedded MiB | Remote objects MiB | View construction ms | Build peak RSS MiB | R2 storage/month USD | R2 reads/1M queries USD |
| ------: | ---------: | -------- | -------------: | -----------: | -----------: | -----------------: | -------------------: | -----------------: | -------------------: | ----------------------: |
|   10000 |          8 | smallest |          715.6 |         1.52 |         1.52 |               0.78 |               0.0012 |              216.7 |              0.00001 |                   0.000 |
|   10000 |          8 | workload |          715.6 |         1.52 |         1.52 |               0.78 |               0.0012 |              208.2 |              0.00001 |                   0.000 |
|   10000 |         16 | smallest |          715.6 |         1.52 |         1.52 |               0.78 |               0.0015 |              207.6 |              0.00001 |                   0.000 |
|   10000 |         16 | workload |          715.6 |         1.52 |         1.52 |               0.78 |               0.0013 |              207.9 |              0.00001 |                   0.000 |
|   10000 |         32 | smallest |          715.6 |         1.52 |         1.52 |               0.78 |               0.0012 |              212.8 |              0.00001 |                   0.000 |
|   10000 |         32 | workload |          715.6 |         1.52 |         1.52 |               0.78 |               0.0012 |              207.7 |              0.00001 |                   0.000 |
|   10000 |         48 | smallest |          715.6 |         1.52 |         1.52 |               0.78 |               0.0013 |              203.2 |              0.00001 |                   0.000 |
|   10000 |         48 | workload |          715.6 |         1.52 |         1.52 |               0.78 |               0.0014 |              212.7 |              0.00001 |                   0.000 |
|  100000 |          8 | smallest |          715.8 |        15.12 |         4.16 |              18.88 |               0.0012 |              382.9 |              0.00030 |                   0.390 |
|  100000 |          8 | workload |          715.8 |        15.12 |         4.16 |              18.88 |               0.0012 |              379.8 |              0.00030 |                   0.000 |
|  100000 |         16 | smallest |          715.8 |        15.12 |        12.16 |              10.88 |               0.0013 |              386.1 |              0.00017 |                   0.240 |
|  100000 |         16 | workload |          715.8 |        15.12 |        12.16 |              10.88 |               0.0013 |              419.4 |              0.00017 |                   0.000 |
|  100000 |         32 | smallest |          715.8 |        15.12 |        15.12 |               7.93 |               0.0013 |              397.0 |              0.00012 |                   0.000 |
|  100000 |         32 | workload |          715.8 |        15.12 |        15.12 |               7.93 |               0.0013 |              439.0 |              0.00012 |                   0.000 |
|  100000 |         48 | smallest |          715.8 |        15.12 |        15.12 |               7.93 |               0.0013 |              398.3 |              0.00012 |                   0.000 |
|  100000 |         48 | workload |          715.8 |        15.12 |        15.12 |               7.93 |               0.0013 |              380.7 |              0.00012 |                   0.000 |
| 1000000 |         48 | smallest |          715.8 |       151.00 |        14.98 |             216.25 |               0.0013 |             1330.7 |              0.00340 |                   0.420 |
| 1000000 |         48 | workload |          715.8 |       151.00 |        14.98 |             216.25 |               0.0012 |             1411.1 |              0.00340 |                   0.000 |

Cost estimates exclude free tiers, Workers request/CPU charges, metadata-query reads, retries, and build/deployment operations. R2 objects include packed metadata even though the measured searches request only IDs. One full reupload costs object count / 1e6 × $4.50 in Class A writes, plus HEAD reads; repeat verified uploads skip PUTs. These small storage estimates do not mean total hosting is free: Workers Paid has a $5 monthly minimum and CPU usage matters for common terms. Pricing sources: [R2](https://developers.cloudflare.com/r2/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/).

This is an initial synthetic baseline: twelve fixed query types, three passes per configuration, one deterministic corpus seed, no real-world corpus supplied. Tail percentiles have limited statistical confidence. Workload-aware selection uses the test queries as training input; validate generalization with independent traffic before choosing a production policy. No measured query failures occurred.
