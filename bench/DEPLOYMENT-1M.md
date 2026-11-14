# Live 1M replacement deployment

Deployed the replacement at [work-search-cws-1m](https://work-search-cws-1m.phulin.workers.dev/health), with exactly 1,000,000 documents. The API accepts GET/POST /search; metadata and query-relevant snippets are included by default. This is a search API deployment; the Casework UI was retired.

The live health response confirms Porter2 normalization, the current complete pair generation, N=100/M=1000, and the four filterable fields: date_filed, precedential_status, opinion_id, cluster_id. Court/jurisdiction enrichment remains separate work. The engine is commit 545306b, with deployment tooling a38b7d3; the exact deployed runtime source hashes and version are in the accompanying artifacts.

## Publication and retirement

Verified 11,616 posting objects and 8,034 complete document-package groups, then published all 167,664 pair/presence/metadata objects (15,871,224,135 bytes). Each new object was checksum-verified by R2 and atomically created; retries checked existing immutable identities. The prepared bundle is 25.69 MiB. Cloudflare reported 9 ms startup. Its [current limits](https://developers.cloudflare.com/workers/platform/limits/) allow 64 MiB uncompressed bundles and 128 MB isolate memory; there is no compressed bundle-size limit.

Removed Casework and its eight engine Workers twice: another deployment recreated them during this task, and the user explicitly requested retirement again. Removed 540 dedicated casework/ objects (379,672,355 bytes); verified the namespace empty and Casework absent from the control plane, with its old endpoint returning 404. Temporary cleanup Workers were removed. Shared corpus/source objects, other deployments and the local 1M mirror were preserved.

## Validation

All 277 repository tests in 76 files passed, as did TypeScript and formatting. Thirteen local reference scenarios passed 26 live authenticated searches, plus the unauthenticated complete-response check. Checks cover document IDs/order, score tolerance, titles/metadata, nonempty snippets, exact totals, Boolean negatives, fields, zero-hit proximity, and filtered pagination. Native CPU observations joined all 26 benchmark search requests by request ID.

The initial harness incorrectly expected 43 total matches after a seven-document cursor; the existing API correctly reports 36 remaining matches. A second assertion incorrectly required every title to be nonempty; one source document has an empty title, and exact reference comparison now handles it. Neither required an engine change. Initial observations are retained in initial-smoke.json.gz and initial-cpu.json.gz.

## Complete-response observations

One observation per query per condition, from the local client. “Application reset” empties application memory within the request; all first-pass queries share one new cache namespace, so overlapping shared pages can be reused. “Repeat” is the second pass over the whole workload, not a guarantee that every block remains resident. Opaque R2 caches are uncontrolled. These are deployment checks, not traffic percentiles or a statistically powered comparison.

| Query                                  | Application reset (s) | Repeat (s) | Native CPU, reset / repeat (ms) |
| -------------------------------------- | --------------------: | ---------: | ------------------------------: |
| Broad Boolean                          |                  1.78 |       0.82 |                       295 / 331 |
| Mixed negative Boolean                 |                  3.47 |       1.28 |                       677 / 568 |
| “in the absence of”                    |                 11.02 |       6.41 |                     1531 / 1078 |
| “burden of proving” (body)             |                  4.08 |       1.23 |                       564 / 514 |
| Requests for admission                 |                  6.41 |       1.43 |                       695 / 575 |
| Mandate rule                           |                  3.87 |       1.03 |                       305 / 306 |
| Second Amendment proximity (zero hit)  |                  1.09 |       0.15 |                        177 / 61 |
| Arbitration + two phrases (20 results) |                  9.05 |       1.93 |                      1214 / 479 |
| Same query + date/status filter        |                  6.66 |       1.85 |                       908 / 623 |
| Filtered page two                      |                  2.02 |       2.80 |                      553 / 1096 |

The first search after deployment, before health/warmup requests, took 9.76 s for seven complete results and the correct exact total of 94. The prior 50-second Casework observation used a different engine and roughly 10.9M documents; it is not a comparable speedup baseline.

## Remaining bottlenecks and readiness

The deployment is functionally validated at 1M, but is not ready for full-corpus latency adoption. Broad phrases and sparse Boolean queries still make too many reads and dependent fetch waves. In the initial application-reset observation, “in the absence of” read 188 MiB through 772 origin requests, with 61 score I/O waves; requests-for-admission used 44 document-package I/O waves. The arbitration query touched about 51 MiB through 196 origin requests. Native CPU was much smaller than complete-response wall time, so local 20 ms I/O assumptions substantially underpredict these live cases.

Filtered pagination also regressed from 2.02 to 2.80 s in this small sample. Per-request cache/isolate and work counters are retained; no broad causal claim follows from one pair. Next, reduce serial I/O and physical overfetch using live 1M measurements before changing the index format or scaling to 10M. Context and excerpt behavior were preserved.

The final usage snapshot reports no CPU/memory limit rejections and zero uploader errors. Uploader invocation-memory P99 was about 60 MiB; this is not a peak. Adaptive analytics had not yet attributed the new serving Worker, so no serving memory percentile is claimed. The temporary cleanup utility produced empty-delete exceptions before its guard was fixed and the utility removed. [Usage snapshot](results/columnar/deployment-1m/usage.json).

This run does not establish throughput, traffic P99, concurrent whole-isolate peak memory or 10M behavior. Instrumented active-buffer and retained-cache counters are separate from native memory observations.

## Reproduce

```sh
yarn deploy work/columnar-worker-stem-1m work-search-cws-1m \
  --membership work/columnar-complete-pairs-1m \
  --metadata work/columnar-metadata-1m
CWS_VARIANTS=work-search-cws-1m CWS_LABEL=deployment-recheck \
  CWS_DRIVER=bench/columnar/deployment-smoke.ts yarn bench:columnar run \
  https://work-search-cws-1m.phulin.workers.dev \
  bench/results/columnar/deployment-1m/contract.json \
  work/columnar-deploy/recheck.json
```

[Machine-readable summary](results/columnar/deployment-1m/summary.json), [complete responses](results/columnar/deployment-1m/live.json.gz), [native CPU/wall observations](results/columnar/deployment-1m/native-cpu.json.gz), [runtime manifest](results/columnar/deployment-1m/deployment.json), and [first deployed search](results/columnar/deployment-1m/first-search.json).
