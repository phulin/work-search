# Live 1M profiling, 2026-11-14

The reported arbitration query is dominated by dependent reads and physical overfetch. Native CPU is material, but substantially smaller than response latency. The deployed engine and index were left unchanged; the temporary instrumentation Worker was deleted and its absence verified through the control plane.

The uninstrumented endpoint was `work-search-cws-1m.phulin.workers.dev`, version `177b51f3-545b-4a15-b95b-31147bd9f142`, targeting `aws:us-east-1`. Corpus, engine source and configuration are recorded in [provenance.json](results/columnar/live-profile-1m/provenance.json) and the preceding [deployment report](DEPLOYMENT-1M.md). Generation begins `e873d554`; this is the deployed 1,000,000-document Porter2 generation, N=100/M=1000, with metadata and snippets.

## Complete-response measurements

Three randomized query/session repetitions per condition, 36 requests total, all from a client entering through BOS. Each query/session used a new shared-page namespace, then an immediate repeat, then shared-page reuse with an in-request application reset. The deployment smoke test instead shared a namespace across queries; its 51 MiB arbitration observation could reuse earlier queries' pages. This run deliberately prevents that reuse for the empty-cache condition. No response caching. These are small diagnostic samples, not production percentiles or a reliable P95/P99 estimate. Opaque R2 backend caches were not controlled. All 36 native CPU/wall observations were joined by request ID.

Medians; CPU columns correspond to the same cache conditions. “Empty” means empty application caches and a fresh shared-page namespace. “Shared warm” means the third condition, with application caches explicitly reset.

| Query                                                              | Empty response | Shared warm response | Native CPU, empty / shared warm | Empty R2 reads / MiB |
| ------------------------------------------------------------------ | -------------: | -------------------: | ------------------------------: | -------------------: |
| `"summary judgment" AND arbitration AND "third party beneficiary"` |         5.79 s |               2.18 s |                    889 / 656 ms |           270 / 75.9 |
| `"in the absence of"`                                              |        11.78 s |               5.64 s |                1,629 / 1,151 ms |          799 / 195.3 |
| Requests for admission + phrase OR                                 |         4.40 s |               1.42 s |                    790 / 466 ms |           294 / 37.9 |
| Mandate rule + Boolean conditions                                  |         2.48 s |               0.66 s |                    347 / 223 ms |           194 / 12.8 |

Arbitration empty-cache responses ranged **4.47–8.49 s**, so the earlier nine-second result is consistent with this run's variability. Immediate-repeat medians were respectively 1.96, 7.30, 1.61 and 0.98 seconds. Full per-cell ranges and sample counts are in [summary.json](results/columnar/live-profile-1m/summary.json).

Twenty distinct isolates served the 36 requests. **None of the 12 same-query immediate repeats reached its predecessor's isolate.** Thus repeat latency does not establish warmed application-memory performance. Three queries nevertheless reached zero R2 reads on repeats, through shared-page reuse. The common phrase still made 352 origin reads on every immediate repeat.

## Arbitration: where the work goes

The engine first selects document execution using an estimate of 385 candidates and 7.3 MiB of packages. After reading the `arbitr`/`beneficiari` anchor intersection, it prices **714 actual candidates, 64.6 MiB, 119 package batches**, against **76.4 MiB of candidate-overlapping posting pages**. Its cost model chooses blocks. This is an explicit actual-cost fallback, **not an obsolete eight-MiB transfer cutoff**. The final diagnostics retain the earlier estimate rather than exposing this losing continuation's actual cost; observation on the profiling copy captured the decision.

The resulting execution:

- Checks 277 candidates and returns 20 results with an exact total of 94.
- Fetches 3,157 distinct score blocks, decodes 413,329 score postings, and uses 56 position I/O waves plus 14 score I/O waves. Counts can overlap; they are not additive critical-path depth.
- Chooses no pair packets and decodes 186,018 common-word presence integers. The complete pair index is present, but this query's planner does not use it.
- Requests 13.0 MiB of distinct binary ranges covering a 75.25 MiB full-page envelope: **5.8× physical amplification**. The 75.9 MiB origin transfer also includes named/presence objects and winner packages. These are all requested ranges, including planning, scores and positions—not just useful bytes for final matches.
- Transfers **no repeated origin byte ranges** in the detailed empty-cache capture. Repeated decoding is only 175 KiB out of 9.4 MiB. Redundant retransmission/decompression is not the principal problem here.

In the detailed continuation capture, 57 unscoped posting-read calls (the 56 positional I/O waves plus another call) occupy a 4.48-second interval union on the Worker clock. Calls proceed in sequence; their first eight durations are 57, 68, 91, 66, 76, 50, 78 and 87 ms. Score-call intervals occupy a 1.17-second union and can overlap other work. Origin GET median is 50 ms, maximum 213 ms. On the immediate repeat, all 326 shared lookups hit, yet those posting-read calls still occupy an 826-ms interval union. **Shared cache is another I/O service, not application memory.**

The forced-isolate diagnostic ran 21 searches inside one active request. After the first search, it still required about **323 shared reads per search**, versus 326 with empty application memory. The working set exceeds the 12 MiB page cache; isolate affinity alone cannot eliminate these reads. These inner calls are diagnostic, not complete-response client benchmarks.

Winner retrieval was 20 packages / 1.03 MiB. Initial instrumented metadata/result retrieval was about 159 ms. It is much smaller than the posting path; excerpt work was not changed.

## Other bottlenecks

**Common phrase cache-budget cliff.** `"in the absence of"` exhausts the shared budget: 460 gets + 440 puts = 900 operations on the first search, with 741 bypasses. An immediate repeat has 352 R2 reads / 84.1 MiB despite previously reading the same query. It also decodes 1.43M score postings and executes 66 positional I/O waves. No pair packet is selected.

A single diagnostic sequence on the isolated copy with budget 10,000 produced 828 shared hits and **zero R2 reads** on both repeats. Immediate-repeat response was 3.90 s versus the normal 7.30 s median; the third response was 6.00 s versus 5.64 s, so latency improvement is not consistent in this small ablation. The empty-cache diagnostic was slower at 18.67 s. It ran alongside the continuation diagnostic briefly; do not treat these times as a controlled speedup. The counter change establishes the budget-induced origin traffic. This is **not a proposed production budget increase**: Cloudflare currently documents 1,000 Cache API calls per paid invocation, alongside different general subrequest limits. The uncached diagnostic attempted 1,620 cache operations without reported errors, which does not establish supported production behavior. Reduce cache-operation demand or prioritize operations within a safe budget. [Current limits](https://developers.cloudflare.com/workers/platform/limits/).

**Document-package batch barriers.** Admission verifies 264 packages / 33.5 MiB in **44 sequential six-document batches**. Mandate verifies 193 / 12.7 MiB in **33 batches** to produce four matches. Batch payloads peak at only 1.88 MiB and 0.89 MiB respectively, below the four-MiB active-batch allowance. The planner's `dependentStages: 2` is not the executed wave count. In a detailed admission capture, package calls occupied a 3.16-second interval union with empty caches, and 1.01 seconds on the immediate repeat. Every batch waits for its slowest member before the next batch starts.

**Remaining CPU.** Admission reports 808,043 pair-membership integers and 2.45 MiB repeated membership decoding out of 3.08 MiB total membership decoding. Mandate scans about one million forward token integers. These are worthwhile secondary CPU targets, but no function-level live attribution was obtained; native invocation totals are the CPU evidence here.

## Measurement limits and validation

Production CPU and sampled-allocation captures each ran for 20 seconds with traffic throughout. CPU returned only root/idle frames (101 bytes); heap returned no allocation samples (97 bytes). A second attempt holding one profiling-copy isolate active throughout returned the same unusable profiles, despite completing 21/24 searches. Raw pprof and traffic records are retained. **No CPU flamegraph or native allocation/peak-memory conclusion is claimed.** Cloudflare's [production profiler](https://developers.cloudflare.com/workers/observability/profiling-in-production/) samples allocations, not retained heap.

Span timing uses the Worker clock, which [advances only on I/O](https://developers.cloudflare.com/workers/runtime-apis/performance/). It cannot measure synchronous CPU sections. Nested intervals overlap and must not be summed or converted into a CPU breakdown. Client response latency comes from the external clock; native invocation CPU/wall comes from sanitized live tail. Native wall may include post-response work. Detailed tracing adds overhead, so the uninstrumented 36-request run supplies the headline latency measurements.

All **54 contract-checked live requests** passed document-ID/order, score-tolerance, exact title/metadata/snippet and requested exact-total checks: 36 original, 12 detailed copy, three continuation observations and three cache-budget observations. No request errors or timeouts occurred in that workload. Yarn TypeScript and formatting checks passed. No format, context, excerpt, scoring or matching implementation changed.

Retained page/decoded counters and active-buffer counters are included separately in the raw results; they do not establish whole-isolate peak memory. The usage snapshot reported no account CPU/memory resource rejections, but still did not attribute serving memory to these Workers. Its account/bucket totals include other activity; nine account errors cannot be attributed to this benchmark. See [usage.json](results/columnar/live-profile-1m/usage.json).

## Recommended next experiment

1. For arbitration, measure pair-derived intersections **before** choosing the continuation. The current no-pair route leaves 714 package candidates and scattered position reads. Compare actual candidate-package bytes against physical posting-page cost, and expose both the estimate and actual decision in diagnostics. Do not assume forcing packages would help: the current six-at-a-time implementation predicts 119 batches.
2. Collapse candidate-filtered positional reads into bounded contiguous/buffered work across windows. This targets the measured 56 serial waves and 5.8× amplification rather than another ranking-bound adjustment.
3. Replace document batch barriers with a bounded rolling pipeline, preserving exact coverage and active-memory limits. Then revisit the document-vs-block cost model using live per-GET/cache latency.
4. Reduce common-phrase cache operations and budget bypasses; treat a larger budget only as diagnostic evidence until platform limits and memory/load behavior are validated. Address repeated membership decoding after the larger I/O costs.

## Reproduction and artifacts

```sh
CWS_VARIANTS=work-search-cws-1m CWS_LABEL=live-profile-1m-base \
  CWS_DRIVER=bench/columnar/live-profile-requests.ts \
  yarn bench:columnar https://work-search-cws-1m.phulin.workers.dev \
  work/live-profile-1m/baseline.json
yarn node --import tsx bench/columnar/deploy-live-profile.ts
# Repeat the driver against work-search-cws-1m-profile for detailed observations.
# CWS_SCENARIOS=8: continuation decision; CWS_SCENARIOS=2 CWS_SHARED_BUDGET=10000:
# diagnostic budget ablation only, not a supported production configuration.
yarn node --import tsx bench/columnar/capture-live-profile.ts \
  work-search-cws-1m work/live-profile-1m/native-production search
yarn wrangler delete --config work/columnar-deploy/work-search-cws-1m-profile.json --force
```

The profiler copies the deployed source/binaries; it wraps reader, cache and R2 operations without replacing the executor. [Summary](results/columnar/live-profile-1m/summary.json), [original complete responses](results/columnar/live-profile-1m/baseline.json.gz), [joined native observations](results/columnar/live-profile-1m/baseline-native.json.gz), [detailed events](results/columnar/live-profile-1m/detail.json.gz), [continuation decision](results/columnar/live-profile-1m/continuation.json.gz), and [budget diagnostic](results/columnar/live-profile-1m/budget.json.gz) retain the full evidence.
