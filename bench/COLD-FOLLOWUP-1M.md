# Cold continuation pricing and candidate-aware phrase execution

Control: `51ba38f`, frozen separately as a complete runtime. Same local 1M
generation, N=100/M=1000, format, complete pair context, scoring and excerpts.
No deployments or uploads were used for these query measurements.

Two general changes:

- Price score execution using its actual eight-window lookahead, rather than
  charging a serial fetch wave for every document band. Compare the physical
  candidate-overlapping page footprint against document verification reads.
  Do not assume an exact-totals-off query will prune half its bytes: fewer than
  K verified matches can require the entire footprint. Preserve the cheap
  package shortcut to avoid discovering detailed score plans unnecessarily.
- Pass already-established conservative Boolean candidates into exact phrase
  streams. Read the same pair stream, but decode positions/context only for
  documents still eligible for the complete query. Preserve fragments spanning
  chunks and GETs, and emit completed sparse batches without waiting for 128
  matches. This does not omit a possible result or change the phrase evaluator.

Neither change contains query-string, legal-term or phrase-specific exceptions.
Cost constants remain workload-informed heuristics, not proofs of optimal
planning. They select between complete exact executions; they never bound
recall. The separate 32-query workload was written before its performance was
examined, and the implementation was not retuned after its results arrived.

## Cold complete-response comparison

Randomized, interleaved, three observations per query/engine. Every timed search
starts with empty application and simulated shared caches. An untimed JIT/data
pass precedes measurements; its application/shared caches are discarded. This
is not a new isolate or cold filesystem. No warm-cache timings or response
caching. All performance scenarios have **exact totals off**. Metadata,
query-relevant snippets and JSON serialization are included.

| Workload             | Measured responses | P50 ms before → after | P95 ms before → after | P99 ms before → after |
| -------------------- | -----------------: | --------------------: | --------------------: | --------------------: |
| Existing 200 queries |              1,200 |             390 → 379 |           1,044 → 744 |           1,296 → 899 |
| Fresh held-out 32    |                192 |             573 → 537 |             976 → 889 |           1,309 → 895 |

These are nearest-rank quantiles across **per-query medians**, not request
traffic percentiles. Three samples are insufficient for reliable request P99
estimates. In particular, the 32-query P99 is its slowest query median. Per-query
min/max values are retained in the machine-readable summaries; the query-quantile
envelopes formed from sample minima/maxima are 382–400 / 1,032–1,047 /
1,292–1,308 ms for the 200-query control, and 370–383 / 735–753 / 891–918 ms
for the replacement. These envelopes are not confidence intervals.

The unchanged simulation is 20 ms origin latency plus 100 MiB/s, six request
slots, 2 ms shared operations, 12 MiB application pages, 4 MiB decoded data and
a 900-operation shared budget. Local Node CPU is not Worker CPU. The harness's
generic manifest still describes priming for warm conditions; `condition:
fresh-namespace` determines the cold reset used here. Opaque R2 backend caches
are not modeled or controlled.

| Query                                       | Cold ms before → after | GETs before → after | MiB before → after |
| ------------------------------------------- | ---------------------: | ------------------: | -----------------: |
| Consent decree / monitor                    |            1,296 → 491 |            286 → 46 |        7.01 → 6.20 |
| Rule 106 / self-serving or interview        |            1,214 → 464 |            277 → 36 |        2.99 → 5.83 |
| Intervention as of right                    |            1,304 → 581 |            280 → 66 |       6.36 → 14.06 |
| Title IX / Spending Clause                  |            1,051 → 482 |            242 → 47 |      11.75 → 13.85 |
| Requests for admission / application of law |          1,103 → 1,100 |           214 → 214 |        8.72 → 8.72 |
| Fraud on the court / nonparty or intervenor |          1,700 → 1,222 |           185 → 185 |      45.60 → 45.60 |

Summing one median counter per query over the 200 gives:

| Work                                 |   Before |    After |
| ------------------------------------ | -------: | -------: |
| Total GETs                           |   12,570 |    8,617 |
| Verification GETs, including winners |    8,673 |    3,838 |
| Transferred bytes                    | 1.119 GB | 1.393 GB |
| Score blocks fetched                 |  220,624 |  244,025 |
| Score postings decoded               |   19.62M |   22.28M |
| Position integers decoded            |    7.77M |    2.24M |
| Score I/O waves                      |      407 |      564 |
| Ordinary position I/O waves          |      236 |      389 |
| Local process CPU                    |  33.74 s |  32.43 s |

More queries now use batched postings instead of hundreds of document GETs.
Consequently score/position wave counters increase while total reads and latency
fall; those counters do not include the rolling document pipeline and cannot
be interpreted as end-to-end dependency depth. CPU P50 increases 125 → 135 ms,
while CPU P95 decreases 392 → 378 ms. Instrumented active-buffer P99 increases
7.90 → 7.93 MiB; this is not retained isolate memory, peak RSS or cumulative
allocation. Buffer counters exclude other runtime/bundle/cache overhead.

On the held-out set, GETs fall 2,142 → 1,640, verification reads 1,171 → 665,
position integers 2.36M → 1.47M, and total process CPU 7.83 → 7.24 s. Bytes
increase 276 → 285 MB. Those totals weight each query once, not production use.

## Profile and remaining regressions

Fraud-on-the-court had 5,411 conservative Boolean candidates but decoded all
3,398,661 occurrences of its pair anchor. Candidate-aware execution decodes
62,610, with identical 114 pair ranges and 29.81 MB of pair bytes. In the main
comparison, complete-query process CPU falls 1,325 → 566 ms. The separate local
CPU profiles corroborate removal of integer/context decoding hotspots; their
sampled allocation data are neither retained nor peak memory measurements.
The remaining large context transfer is untouched by this fix.

Two original queries regress by both >10% and >10 ms:

| Query                                              | Cold ms before → after | Explanation                                                                  |
| -------------------------------------------------- | ---------------------: | ---------------------------------------------------------------------------- |
| Motion to seal / pretrial brief / competitive harm |              659 → 744 | 151 → 80 GETs, but 6.55 → 28.50 MiB and more score CPU after choosing blocks |
| Rule 37(d) / failure to appear / deposition        |              391 → 431 | Same 39 verification records, plus 11 unnecessary planning GETs              |

Smaller regressions include 1407(a) remand/pretrial proceedings, 813 → 855 ms
(5.08 → 33.89 MiB), and withdrawal/counsel, 867 → 899 ms with unchanged bytes
and GETs. No held-out query crosses the stated >10% and >10 ms threshold;
smaller differences remain in its summary. This is evidence of generalization,
not a guarantee for arbitrary workloads or native Workers.

The first wave-pricing pilot was rejected: removing the inexpensive package
shortcut added remote plan discovery to cheap queries and switched admission
into an inferior plan. The refined pilot and final comparisons are retained;
the rejected behavior has no production flag.

Next: make detailed-plan discovery earn its cost and include estimated numeric
decoding CPU in continuation pricing. Test that on another fresh workload;
do not add per-query exceptions. Separately, skipping physical context ranges
outside known candidate spans could address fraud's unchanged transfer, but
requires trustworthy range-level document bounds and is outside this change.

## Validation and reproduction

- All 200 + 32 comparisons preserve ranked document IDs/order and score tolerance.
- Separate independent 160-query oracle and 29 focused cases pass, retaining
  exact totals where their correctness contracts require them. The held-out
  expected results come from the frozen runtime, not an exhaustive oracle.
- `yarn run check`, `yarn test`: 87 files, 323 tests pass. Added adversarial
  candidate filtering checks include split occurrence rows, fields, sparse
  windows and empty candidate sets; continuation tests establish cheap shared
  block selection without planning I/O.

With the retained local 1M files:

```sh
yarn node --import tsx bench/columnar/run-cold-followup.ts
yarn node --import tsx bench/columnar/report-verification-gets.ts work/columnar-bench/cold-followup-final-200.json.gz bench/results/columnar/cold-followup-1m/main
yarn node --import tsx bench/columnar/report-verification-gets.ts work/columnar-bench/cold-followup-heldout-32.json.gz bench/results/columnar/cold-followup-1m/heldout
```

Raw comparisons, corpus/configuration/source identities, contracts, profiles and
rejected pilots are in `bench/results/columnar/cold-followup-1m/`.
