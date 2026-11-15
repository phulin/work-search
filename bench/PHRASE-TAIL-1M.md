# Slowest 20 cold queries on 1M documents

These are the slowest 10% of the completed 200-query comparison in
[PHRASE-PLANNER-1M.md](PHRASE-PLANNER-1M.md). Every query has `exactTotal:false`,
metadata and matching snippets enabled, and limit 20. Selection uses the new
engine's median of three cold simulated complete responses, not an instrumented
profile's duration. No deployments or index changes were made.

## Queries and execution work

Reads and MiB are origin totals, including planning and presentation. Position
and score waves count their respective dependent I/O phases; they are not the
total dependency depth and cannot be added to compute latency. A zero indicates
that document verification handled matching/scoring instead of ordinary postings.

|   # | Query                                                                                                                                              | Cold ms | Origin reads |  MiB | Position waves | Score waves |
| --: | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | -----------: | ---: | -------------: | ----------: |
|   1 | `"fraud on the court" AND (nonparty OR intervenor) AND appeal`                                                                                     |   2,176 |          261 | 64.7 |             49 |           8 |
|   2 | `"statute of limitations" AND "fraudulent concealment" AND "motion to dismiss"`                                                                    |   2,137 |          286 | 70.7 |             41 |          11 |
|   3 | `"intervention as of right" AND (timeliness OR "inadequate representation")`                                                                       |   1,953 |          462 |  8.9 |              0 |           0 |
|   4 | `"requests for admission" AND ("application of law to fact" OR "legal conclusions")`                                                               |   1,931 |          452 | 15.1 |              0 |           0 |
|   5 | `(withdraw OR withdrawal OR withdrawn OR withdrawing) W/P counsel AND ("fundamental disagreement" OR "breakdown in communication") AND sentencing` |   1,801 |          418 |  9.4 |              0 |           0 |
|   6 | `"stay discovery" AND "motion to dismiss" AND ("good cause" OR prejudice)`                                                                         |   1,587 |          176 | 40.8 |             39 |           7 |
|   7 | `"Rule 15" AND "undue prejudice" AND "leave to amend"`                                                                                             |   1,504 |          169 | 39.2 |             37 |           7 |
|   8 | `"Rule 62.1" AND "dissolve" AND "preliminary injunction"`                                                                                          |   1,469 |           88 | 22.1 |             38 |           8 |
|   9 | `"Rule 6(b)" AND "excusable neglect" AND "late opposition"`                                                                                        |   1,423 |           90 | 22.8 |             35 |           8 |
|  10 | `"Rule 16" AND "good cause" AND ("additional depositions" OR discovery)`                                                                           |   1,309 |          106 | 21.7 |             27 |           7 |
|  11 | `"1407" AND centralization AND (competitors OR "different defendants")`                                                                            |   1,300 |           86 | 17.3 |             34 |           7 |
|  12 | `"Rule 26(f)" AND (defer OR stay) AND "motion to dismiss"`                                                                                         |   1,290 |          142 | 31.8 |             28 |           6 |
|  13 | `"public access" W/P "summary judgment hearing" AND closure`                                                                                       |   1,287 |           81 | 21.5 |             35 |           7 |
|  14 | `("direct evidence" W/10 "anticompetitive effects") AND "market definition"`                                                                       |   1,258 |           88 | 22.8 |             36 |           6 |
|  15 | `"Rule 408" AND "attorney fees" AND "settlement negotiations"`                                                                                     |   1,251 |           81 | 18.1 |             32 |           6 |
|  16 | `"consent decree" AND monitor AND (interpretation OR compliance)`                                                                                  |   1,247 |          286 |  7.0 |              0 |           0 |
|  17 | `"leave to amend" AND futility AND ("frivolous claims" OR "claim preclusion")`                                                                     |   1,231 |          114 | 25.2 |             27 |           7 |
|  18 | `"Rule 106" W/P ("self serving" OR interview)`                                                                                                     |   1,179 |          277 |  3.0 |              0 |           0 |
|  19 | `"Rooker Feldman" W/P ("independent injury" OR "third party conduct")`                                                                             |   1,154 |           78 | 19.5 |             28 |           7 |
|  20 | `reconsideration AND "summary judgment" AND "new arguments"`                                                                                       |   1,144 |           79 | 15.4 |             23 |           8 |

## What the I/O traces establish

Fifteen queries have substantial ordinary-word positional I/O. Five use the
document-verification continuation: intervention, admission, withdrawal, consent
decree and Rule 106. The two groups need different fixes.

| Query                     | Dominant origin category | Reads |  MiB | Origin-active union, ms |
| ------------------------- | ------------------------ | ----: | ---: | ----------------------: |
| Fraud on the court        | Word positions           |   190 | 47.5 |                   1,273 |
| Limitations / concealment | Word positions           |   215 | 53.7 |                   1,255 |
| Stay discovery            | Word positions           |   110 | 27.5 |                     914 |
| Intervention              | Document verification    |   428 |  5.8 |                   1,684 |
| Admission                 | Document verification    |   407 |  9.5 |                   1,615 |
| Withdrawal                | Document verification    |   384 |  6.3 |                   1,532 |

The first two queries still have 49 and 41 positional waves after score waves
have fallen to 8 and 11. Their traced positional transfers are respectively
about 20.5 and 17.9 times the requested logical positional block bytes reported
by the executor (2.31 and 3.00 MiB). That ratio includes physical page overfetch
and any repeated transfers; it is not a measurement of a theoretical minimum.
The next experiment should separately count unique ranges and repeated pages
while batching filtered positional requirements across bounded windows.

Intervention demonstrates the other problem: 5.8 MiB of verification data but
428 reads. At the model's six slots and 20 ms origin latency, even a perfectly
packed schedule of those reads costs roughly 1.44 seconds before transfer and
other stages. The traced verification-active union is 1.68 seconds. Broadening
score lookahead cannot fix that request count. Inspect which document sections
share objects and offsets, then compare coalesced ranges with additional bytes;
do not assume unrelated objects can be combined into one R2 GET.

Presentation is not the primary bottleneck. Fraud's result retrieval uses 21
reads and 0.62 MiB, with about 100 ms of origin-active time. Intervention and
admission each retrieve only about 0.18 MiB of winner display content. The public
access query returns no results and still takes 1.29 seconds. Excerpt algorithms
were left unchanged.

These category durations are interval unions from one separately instrumented
cold request per query. Categories can overlap each other and CPU; they are not
exclusive critical-path shares and must not be summed. Instrumentation and
waiting for deferred cache writes change the timing basis. Use the three-repeat
unprofiled benchmark for before/after latency.

## CPU and allocations

Eight additional calls per query were sampled with empty application/shared
caches and artificial I/O delays disabled. Three further calls sampled
allocations. These runs identify local Node hot functions, not native Worker
CPU or the CPU distribution during delayed I/O.

- Fraud: packed integer/column decoding, score-batch append/MAXSCORE, repeated
  document-directory lookup, and storage/cache bookkeeping. After excluding
  idle, unattributed program and inspector samples, these groups account for
  about 19%, 19%, 13% and 20% of sampled self time respectively.
- Limitations: storage/cache bookkeeping (21%), scoring/pruning (16%),
  Boolean/proximity evaluation (12%) and execution loops remain substantial.
- Intervention and admission: document verification/presentation routines
  account for about 26% and 21% of sampled self time, with packed decoding
  another 15% and 19%. Runtime/model work remains a large remainder. Hot
  functions include document block decoding, frequency access, document-directory
  lookup and packet execution.
- Stay discovery, Rule 16, Rule 26(f), leave to amend and reconsideration also
  spend significant sampled time in phrase/membership/position execution.

These are sample distributions after the stated exclusions, not percentages of
request wall time. Fraud's no-delay sampled calls use a median 249 ms of process
CPU, versus 830 ms in the delayed unprofiled benchmark. Limitations is 215 versus
765 ms. Origin reads/bytes, decoded bytes, scored postings, position integers and
inflated bytes agree between their first no-delay calls and separate I/O traces;
small cache-operation counts differ with scheduling. The CPU discrepancy is not
explained by those work counters. Do not substitute no-delay CPU into the cold
benchmark, subtract it from wall time, or claim a native CPU saving from it.

Sampled cumulative allocation is approximately 162 MiB/request for fraud,
115 MiB for limitations, 84 MiB for intervention and 112 MiB for admission.
These estimates include transient allocations and profiler effects. They do not
measure retained memory, peak live memory, or a Workers memory limit violation.

## Recommended next experiment

1. Bounded candidate-aware positional lookahead and stable range coalescing for
   the 15 postings queries. Track dependent waves, unique/repeated transfer,
   useful block bytes, overfetch and active buffers; reject latency wins that
   depend on unbounded speculative reads.
2. Reduce document-verification GETs for the five document queries. First
   establish the coalescible physical footprint, then price that continuation
   against postings using actual request counts and bytes.
3. Profile CPU again after removing those waits. Packed decoding, repeated
   directory lookup, score-batch construction and verification allocation are
   concrete local targets; presentation remains lower priority.

The full query contract, per-query counters, CPU/allocation profiles and tagged
I/O timelines are retained in
[tail-summary.json](results/columnar/phrase-planner-1m/tail-summary.json) and
[profiles/tail](results/columnar/phrase-planner-1m/profiles/tail). The reproduction
commands are in the main report. This analysis establishes priorities, not
measured gains for the proposed next changes.
