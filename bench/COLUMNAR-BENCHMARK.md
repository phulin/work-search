# Replacement benchmark ledger

The replacement runs on isolated live Workers. It is **not ready for full-corpus
adoption** while the scale, startup, load and native memory gates below remain.
The public demo has not changed. This ledger distinguishes completed measurements
from work still running.

## Pinned comparison

The checkout began at `dd08b3c943362af8a3d404ed5cb6bc28d402b914`. The frozen control
archives `4f97eb49f1aa2115fbc3026c4924a1182a90917b`: unchanged global engine,
8 MiB bundled heads, 256 KiB physical pages and inline positional pairs. Its outer
wrapper adds request/isolate identifiers and authenticated cache namespaces.
Application resets execute inside the same POST as search; they do not assert a
new isolate. Core comparisons include metadata and query-relevant snippets and
disable response caching. No experiment claims control over opaque R2 caches.

The 100k replacement's independent-lane generation is
`f7c6dd43f97a78f21223c8123da8859bec9a169868bca181b832bf5d465d9f19`.
Its corpus hash is `e621b2654ab99a61b8f558dd912193002594de4086d8e1d560324637ef14fb06`.
Original 32 scenarios, fresh held-out expressions and field/pagination contracts
form 76 scenarios. Query-class results remain separate in the JSON reports.
The aggregate is a roughly uniform scenario mixture, **not production traffic**.

Each raw compressed run contains timestamps, seed, workload/options, cache state,
health/generation, request/isolate IDs, correctness, complete client time, arrival
lateness, errors and counters. Sanitized live tails provide sampled native CPU
and wall time joined by request ID. Tail coverage is incomplete. Deployment
manifests under `work/columnar-deploy` pin runtime snapshots and source hashes.
Report code computes query/session-block bootstrap intervals; small pilot P99s
remain exploratory. Machine-readable raw and summarized data are in
[`results/columnar`](results/columnar).

## Substantial application-memory-reuse run

`finalists-memory` ran three randomized/interleaved sessions, 10,000 attempts per
variant, at 12 total arrivals/sec across the three variants. The local client was
in New England, with observed BOS ingress. Success percentiles include receipt
of the complete body and JSON parsing; rejected/timed-out requests remain in the
all-outcomes distributions and error counts.

| Variant            | Attempts |      P50 |        P95 |         P99 | HTTP 503 | Timeout |
| ------------------ | -------: | -------: | ---------: | ----------: | -------: | ------: |
| Frozen control     |   10,000 | 266.8 ms | 4,410.2 ms | 21,483.6 ms |      132 |       2 |
| V3 certificates    |   10,000 | 191.4 ms |   508.2 ms |    661.6 ms |        0 |       0 |
| V5 candidate masks |   10,000 | 188.7 ms |   483.6 ms |    632.6 ms |        3 |       0 |

All successful responses matched their independent/original oracle. Native CPU
P50/P95/P99 was 144/3,047/5,241 ms for 4,371 joined control observations,
77/212/304 ms for 4,268 V3 observations and 77/209/315 ms for 4,170 V5 observations.
Successful replacement maxima exceeded 21 seconds despite subsecond sampled CPU;
the raw client/worker timings should be consulted before attributing those
outliers to execution. Local corpus/pair work overlapped the campaign; brief
initial immutable uploads also overlapped. Background waiters originally polled
by inflating the raw result file; that avoidable local CPU work was removed.
These limitations are retained rather than treating a warmed cache as controlled
physical infrastructure.

## Measured iterations and rejected experiments

| Live pilot                       | Requests per variant | Complete P50/P95/P99 (replacement) | Finding                                                                                          |
| -------------------------------- | -------------------: | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| V1                               |                   64 | 758.8/1,267.3/1,581.4 ms           | Regressed against control 202.5/924.8/2,346.6 ms                                                 |
| V2 independent lanes/cache fixes |                   64 | 152.0/406.1/530.8 ms               | Improved against control 157.9/875.8/2,299.0 ms; small sample                                    |
| V3 expanded contracts            |                  200 | 191.3/427.9/522.8 ms               | Zero replacement errors; control had three 503s                                                  |
| V4 alternate pair selection      |                  200 | 233.9/550.1/706.6 ms               | Rejected; V3 was 182.1/408.8/483.6 ms                                                            |
| V5 candidate masks               |                  200 | 186.3/422.2/516.8 ms               | Retained; later substantial run above                                                            |
| V7 native synchronous gzip       |                  500 | 214.5/524.3/708.7 ms               | Rejected; V6 was 178.4/422.6/504.4 ms                                                            |
| V8 certificate band ordering     |                  500 | 182.9/422.2/504.4 ms               | Removed: no convincing aggregate gain against V6 181.2/426.3/517.2 ms, higher median sampled CPU |

V1 local workerd samples attributed roughly 39–71% of several queries' CPU to
rechecking CRCs on already-validated shared pages. The replacement now reuses
validation receipts, compiles coarse Boolean predicates outside candidate loops,
uses independent physical lanes, prunes conservative 128-document cells, and
reuses decoded blocks before fetching their source pages. Local attribution alone
was not considered proof of deployed gains. Native gzip is an explicit example
where a favorable microbenchmark failed the complete-response live comparison.

V6 additionally decodes positions only for requested fields, bounds deferred
shared-cache writes and records errors with telemetry. V9 freezes the current
runtime after removing unsuccessful band ordering; its substantial warm-shared,
empty-application-memory comparison is running.

## Regional observations

Two placed Worker clients fetch and parse complete upstream responses. Their
measurements are data-center client timings, not end-user last-mile latency.
Health and response placement headers identify SEA and FRA; request `cf.colo`
continues to identify ingress and is not used to claim execution placement.

V6 FRA: 1,000 attempts, no errors, P50/P95/P99 200/542/705 ms. V6 SEA: 1,000
attempts, one 503, successful P50/P95/P99 260/749/926 ms. Successful responses were
correct. An earlier 500-attempt-per-region run failed with HTTP 500 because the
client Worker lacked the public-fetch compatibility flag; those raw harness
failures are retained separately and excluded from engine performance claims.

## Scale and correctness

The direct 1M native generation
`cbf90efb330f43d3b8c2b014589dabf313dc1ed9af334d2c11e12c0869f2dd32` contains
1,000,000 documents, 2,812,380 terms and 58,183,344,294 serving bytes in 1,716
objects. Its canonical corpus hash is
`7776178824e974e234bcb8d6e5a6b32598a2bdd01311866217b4d8048e372fcc`.
The independent exhaustive scan verified corpus count/hash, token averages,
queried document frequencies and 76 ranked scenarios. The resumed build's
205.5-second wall time is **not a fresh-build time**: prior ingestion and checkpoint
work are separate. Its pair builder selected 332,693 pairs, 2,117,195 pair/document
rows and 2,383,914 occurrences, producing 276,612,344 bytes in 1,876 seconds.
Exact bundled certificates took about 51 seconds and occupy about 6.07 MB.

A fresh 1,000-document remote-spill build passed 96 live query/field comparisons
including metadata and snippet presence, using CRC metadata returned with R2
range reads. Its temporary R2 streams were successfully deleted. The full official
snapshot is now being constructed through that bounded path; CI is being prepared
to avoid local upload bandwidth dominating the build. Actual 1M and largest-corpus
live performance are pending and are not inferred from 100k.

191 repository tests pass, including independent exhaustive small corpora,
70k-vocabulary hierarchical routing, adversarial compound winners absent from
single-term certificates, phrases/proximity/negatives, long repeated documents,
fields/boosts, deterministic ties, search-after, corruption, generation consistency,
workerd R2/Cache API and concurrent admission. Native unit tests and fmt/clippy
also pass. Unicode tests preserve unpaired UTF-16 IDs/metadata/passages and exact
preview slicing. Rust float64 scores are checked with the user-authorized relative
1e-11 tolerance; cursors are verified independently and use the tested engine's
returned score.

## Memory, profiling and remaining gates

Page and decoded cache charges are bounded at 24 MiB and 4 MiB. Active numeric
buffers, pending shared-write bytes and cumulative decoded/inflated bytes are
reported separately. Local inspector heap plus backing storage reached about
93.6 MB with concurrent requests, including pending garbage. Forced collection
was unavailable; this is neither native peak nor native retained-memory proof.
Admission allows two active requests per isolate and reports excess work as 503.

Repeated production CPU/heap profile API attempts returned HTTP 404, code 10393,
“No recent executions were found,” despite concurrent successful traffic and both
an exact active version and `latest-deployed`. Native tail CPU/wall observations
are available; production allocation attribution and peak/retained memory remain
unestablished. The current `stages` counter counts execution batches, not a full
I/O dependency graph. These are measurement gaps, not zero-cost observations.

Remaining adoption gates: complete the substantial empty-application-cache run;
fresh namespaces and actual deployment/startup trials; controlled load ladders
with queueing/rejections; live correctness/performance at 1M and the full available
snapshot; native retained/peak memory under load; and identification/optimization
of scale-specific bottlenecks. See [the design](COLUMNAR-DESIGN.md) for the final
format and reproducible construction/deployment commands. Current official limits
and profiling behavior are documented by [Cloudflare](https://developers.cloudflare.com/workers/platform/limits/)
and its [production profiling documentation](https://developers.cloudflare.com/workers/observability/profiling-in-production/).
