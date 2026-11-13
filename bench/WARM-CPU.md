# Warm CPU follow-up on the local 1M corpus

This round compares the replacement with untouched commit `3572902`. The binary
format, context records, sorted postings, N=100/M=1,000, analysis, float64 ranking
and excerpt code are unchanged. Everything uses local 1M bytes and simulated
I/O; there are no uploads, deployments or live Cloudflare calls.

## Diagnosis and retained changes

CPU sampling with readable TypeScript compilation located the main scan cost in
the per-document partial-score loop inside the large asynchronous `search`
function. Allocation sampling attributed hundreds of MB per broad response to
that function. These are cumulative sampled V8 heap allocations, not retained or peak
memory or a count of external ArrayBuffer bytes. The profiles support moving the numeric loop; they do not independently
prove the V8 mechanism responsible for each allocation.

The retained implementation:

- Uses the **essential union as the candidate generator**, before Boolean
  dispatch or partial-score arithmetic. Previously the executor selected and
  decoded essential terms but scanned documents outside that union anyway.
  Unloaded terms in mixed negative/phrase expressions leave Boolean truth
  unknown, so those documents often reached the expensive partial-score loop.
  Completeness follows from the existing selection proof: either a mandatory
  term generates every match, or the optional score maxima are strictly below
  the verified competitive threshold. No rank union is used for exact totals,
  an unfilled heap or a nonpositive threshold.
- Runs candidate selection and final scoring in small synchronous numeric
  functions with indexed term loops, reusable arrays and one threshold snapshot
  per band. No heap insertion occurs during those functions. Only the existing
  subsequent exact matching path can insert a verified match. Original float64
  summation order, field boosts, ties and search-after comparisons remain.
- Specializes presence predicates after each decode phase: unloaded terms are
  unknown; loaded terms directly use handles and field frequencies. Negative
  positional truth remains unknown until verified.
- Computes conservative per-cell maxima once and reuses them for initial and
  partial pruning. Removing a block touching only rejected cells cannot change
  a surviving cell's maximum.

A trial that evaluated the entire Boolean AST into byte columns per window was
slower across the diagnostic queries and was removed. No alternative engine or
permanent experiment flag remains.

## Reproduction and measurement

```sh
yarn node --import tsx bench/columnar/freeze-cpu-control.ts
CWS_CONTROL_SOURCE=work/cpu-control-3572902 CWS_CONTROL_RUNTIME=frozen CWS_CAMPAIGN=warm-cpu-union-1m CWS_REPEATS=3 CWS_SESSIONS=2 yarn node --import tsx bench/columnar/planner-campaign.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/warm-cpu-contract-1m.json
yarn node --import tsx bench/columnar/report-maxscore.ts warm-cpu-union-1m bench/results/columnar/warm-cpu-1m work/cpu-control-3572902/control.json
CWS_PROFILE_SOURCE=work/cpu-control-3572902 yarn node --import tsx bench/columnar/profile-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/maxscore-contract-1m.json work/warm-cpu-profile-before
yarn node --import tsx bench/columnar/profile-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/maxscore-contract-1m.json work/warm-cpu-profile-after
```

The archived workload extends the previous 18 contracts with source-oracle
contracts for negative phrases, double negation and a negative term conjunction.
The harness now freezes Reader, caches and directories along with search, rather
than allowing later storage changes into the control. Complete semantic response
hashes compare exact score bits, metadata, excerpts and totals between versions;
source-oracle checks remain separate. Hashing occurs outside response timing.

The model remains origin 20 ms + 100 MiB/s, shared cache 2 ms + 1,000 MiB/s,
12 MiB application page cache and bounded 1 GiB simulated shared cache per
version. Responses are uncached. Two randomized/interleaved sessions compare
application reuse, empty application caches with warm shared pages, and fresh
application/shared namespaces. Bundled roots stay resident; these are not new
isolates. Filesystem caches are uncontrolled. CPU is local process CPU, latency
includes complete result rendering/serialization and simulated storage delays.
Quartiles/ranges and sample counts accompany the raw data; these samples do not
support production percentiles or P99 claims.

`partialScoreRejected` now also counts rejection outside the proved essential
union within surviving cells/masks. Its total is not comparable as a count of
bound-arithmetic rejections alone. Score blocks, postings, position integers,
reads, bytes and fetch-wave counters retain their definitions.

A separate longer warm CPU comparison disables simulated delays and the
inspector, warms each query five times, then randomly interleaves 30 complete
responses per version/query in **separate processes**. Two independent process
pairs give 60 responses/version/query. Each child measures total CPU between
batch start/finish, including its own background GC, deferred cache work and IPC.
This avoids charging control-induced GC to replacement requests on one shared
Node heap. It uses independent bounded caches and checks source ranks plus exact
complete-response hashes. This is still local process CPU, not native Worker CPU.
The discarded shared-heap pilot is archived with that label.

```sh
CWS_CONTROL_SOURCE=work/cpu-control-3572902 CWS_REPEATS=30 CWS_CPU_LABEL=s1 yarn node --import tsx bench/columnar/compare-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/warm-cpu-contract-1m.json bench/results/columnar/warm-cpu-1m
CWS_CONTROL_SOURCE=work/cpu-control-3572902 CWS_REPEATS=30 CWS_SEED=20269032 CWS_CPU_LABEL=s2 yarn node --import tsx bench/columnar/compare-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m work/columnar-bench/warm-cpu-contract-1m.json bench/results/columnar/warm-cpu-1m
```

## Results and remaining regressions

All 756 simulated-I/O responses passed source-oracle checks and exact semantic
response hashes across versions: 21 contracts × 2 versions × 3 repeats × 2
sessions × 3 cache conditions. All 960 isolated-process CPU responses also passed.
The separate 160-contract source-oracle replay passed, as did all 246 repository
tests in 66 files, TypeScript checking and formatting checks.

CPU below is total isolated child batch CPU / responses, including background
work, averaged across two sessions. Latency is the separate simulated-I/O
complete-response median, six observations/version/condition. Values are ms,
control → replacement:

| Query                                                                              | Isolated warm CPU | App reuse latency | Empty app / warm shared | Fresh app / shared |
| ---------------------------------------------------------------------------------- | ----------------: | ----------------: | ----------------------: | -----------------: |
| Mixed negative: `(jurisdiction OR "summary judgment") AND NOT "res ipsa loquitur"` |      136.6 → 96.9 |         325 → 297 |               347 → 290 |      2,596 → 2,587 |
| `summary judgment` conjunction                                                     |       68.9 → 30.2 |           70 → 67 |                 82 → 73 |          689 → 697 |
| `(of OR the) AND limit`                                                            |       62.7 → 61.6 |         219 → 210 |               218 → 214 |      1,922 → 1,922 |
| Broad common OR                                                                    |     192.1 → 182.9 |         368 → 319 |               365 → 338 |      2,549 → 2,546 |
| `court NOT "personal jurisdiction"`                                                |       51.9 → 53.3 |         282 → 268 |               297 → 268 |      2,756 → 2,780 |
| `(rules OR of) AND rule`                                                           |       48.3 → 54.3 |         135 → 129 |               140 → 134 |      1,216 → 1,207 |
| `"in the absence of"`                                                              |     203.3 → 193.8 |         977 → 970 |               984 → 992 |      6,136 → 6,147 |
| `"burden of proving"` (body)                                                       |       53.2 → 58.9 |         289 → 286 |               305 → 289 |      2,954 → 2,970 |

Mixed-negative CPU session means were 136.4–136.9 → 95.8–98.0 ms; summary
conjunction 66.2–71.5 → 28.8–31.6 ms; broad OR 191.6–192.5 → 182.7–183.1 ms.
Those CPU reductions repeat across process pairs. These are descriptive session
ranges, not confidence intervals. The shared-process simulated-I/O CPU counters
remain in the raw files but are less reliable for attributing background GC to
one implementation. The isolated batch comparison is the CPU assessment above.

**CPU regressions remain:** rules +12.4% and burden +10.7%. Both repeat across
isolated process pairs (rules 46.4–50.2 → 54.2–54.4 ms; burden 53.1–53.3 →
58.0–59.9 ms), even though their elapsed times improve. Personal-jurisdiction
negation is +2.8%, with overlapping session ranges. Standalone profiles of rules
and burden show lower main-thread sampled scan cost and allocation, which does
not explain away the aggregate CPU regression. Further phase/background CPU
attribution is required; these cases are not declared fixed.

Latency also has residual regressions: double-negated clear/convincing is
361 → 372 ms under app reuse; `"the and of the"` is 387 → 408 ms with empty app
caches/warm shared pages; phrase pagination is 226 → 235 ms there. Fresh-cache
changes are generally small and I/O-dominated, with several slight regressions
shown in the full results. For uncertainty, mixed-negative app-reuse IQR is
324–357 → 278–317 ms; double-negation app-reuse IQR is 338–376 → 357–405 ms.
Small samples do not establish tail percentiles.

Logical score-block counts, decoded postings, position integers and score
fetch/I/O-wave medians are unchanged for every contract/cache case. Physical
reads/bytes are unchanged in the empty-app conditions, but vary under app reuse
as the independently ordered bounded caches evict different pages. For example,
mixed-negative shared reads are 158 → 162 and bytes 35.4 → 36.0 MB; absence origin
reads are 40 → 44 and bytes 6.0 → 7.1 MB. These cache-hit differences are retained
in the raw results, not hidden by logical counters.
For the mixed negative query: 7,211 unique score blocks, 903,600 decoded score
postings, 5,880 position integers and 43 score I/O waves. The improvement is
reduced scan/allocation work, not omitted matching, quantized scores, fewer
excerpts or another fetch wave.

Diagnostic allocation sampling estimates mixed-negative cumulative V8 heap
allocation at 299 → 45 MB/response, broad OR 453 → 110 MB, summary conjunction
46 → 19 MB. These are estimates from three allocation-sampled calls, separate
from latency and retained/peak-memory measurements. No native concurrency-memory
claim is made. Numeric workspaces and cache budgets are unchanged.

Next, attribute the residual rules/burden batch CPU costs, including background
GC, before adding more pruning. For complete-response latency, the next target
is batching the remaining score/metadata fetch phases: a mixed-negative warm
sample still has 162 shared reads / 36 MB and 43 score I/O phases. Its result
retrieval took about 9 ms, so excerpt changes are not justified here.

Raw data and all query-level quartiles/ranges are in
[`results/columnar/warm-cpu-1m`](results/columnar/warm-cpu-1m), including both
isolated CPU process pairs, source/control identities, complete result hashes,
profiles, correctness replay and validation logs.
