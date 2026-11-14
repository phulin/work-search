# Remove CRC32 from search serving

This removes CRC32 calculation from the serving Reader, including posting pages,
coalesced term packets, pair/common-presence packets and grouped document
packages. The R2 source no longer parses page/document CRC metadata, and the
offline query adapter no longer computes checksums for the Reader. Generation
identities, range and length checks, structural decoders, exact ranking,
metadata and excerpts remain. Existing SHA-256 verification for ungrouped
whole-document objects is unchanged; CRC was not replaced with another hash.

The index format and bytes are unchanged. Existing CRC fields are ignored by
serving. Construction and download/preparation tools retain their offline
validation and historical benchmark controls retain their original code. The
Reader no longer detects arbitrary same-length payload corruption by checksum;
structural errors, wrong generations and truncated responses remain errors.

Packet coalescing now works without requiring a checksum directory. This also
removes the old dependency on checksum metadata for this path in deployed
indexes. There were no Cloudflare operations in this round.

## Validation and reproduction

The unchanged control is `19ea9da`. Local data, corpus generation, stemming,
N=100/M=1000, format, contexts, excerpts, caches and query contracts are unchanged.
The 180-query workload retains the same nine finite rewrites of `!` expressions.
The eight-query CPU confirmation includes four older source-oracle regression
queries and four expensive queries from the 180-query workload. Those four
frozen responses were checked against the previously archived complete-response
hashes; they are not an independent exhaustive oracle.

```sh
yarn node --import tsx bench/columnar/freeze-cpu-control.ts 19ea9da
CWS_CONTROL_SOURCE=work/cpu-control-19ea9da CWS_CPU_ALL=1 CWS_REPEATS=10 CWS_CPU_LABEL=no-crc-s1 yarn node --import tsx bench/columnar/compare-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m bench/results/columnar/no-crc-1m/cpu-contract.json work/no-crc-cpu
CWS_CONTROL_SOURCE=work/cpu-control-19ea9da CWS_CPU_ALL=1 CWS_REPEATS=10 CWS_SEED=20269032 CWS_CPU_LABEL=no-crc-s2 yarn node --import tsx bench/columnar/compare-warm-cpu.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m bench/results/columnar/no-crc-1m/cpu-contract.json work/no-crc-cpu
yarn node --import tsx bench/columnar/report-cpu.ts work/no-crc-cpu bench/results/columnar/no-crc-1m
```

CPU uses two independent process pairs, five warmups and ten measured responses
per query/version/session: 20 per query/version. Requests are randomly interleaved
between processes. Batch CPU includes each process's own deferred cache work,
GC and IPC. It is local Node CPU, not Worker CPU or native latency.

The 180-query run uses the unchanged `research-profile.ts` harness. Each query has
three simulated responses per cache condition and three no-delay CPU observations;
a separate process captures four CPU-profiled and two allocation-profiled responses.
The before run is archived in `results/columnar/research-180-1m/`; this comparison
uses the same seed and procedure but separate sessions, not interleaved versions.
Small cross-session differences should not be interpreted as proven speedups or
regressions. Cache conditions are reused application memory and empty application
caches over a primed shared namespace. They are repeated-query measurements,
not mixed-query cache behavior or startup. The priming pass remains subject to
the operation budget and does not fully populate every large query.

The simulated model remains origin 20 ms + 100 MiB/s, shared 2 ms + 1,000 MiB/s,
12 MiB application pages, 4 MiB decoded cache and 1 GiB simulated shared pages.
Every response includes metadata, snippets and serialization; there is no
response cache. See `RESEARCH-180.md` for the workload's provenance, rewriting,
proximity semantics and measurement limitations.

## Interleaved CPU confirmation

Mean batch CPU in ms, frozen control → no CRC, 20 responses/version/query across
two independent process pairs:

| Query                               |          CPU ms | Change |
| ----------------------------------- | --------------: | -----: |
| Requests for admission              | 693.77 → 276.44 | −60.2% |
| Mandate rule                        | 646.11 → 262.32 | −59.4% |
| Rules Boolean                       |   65.83 → 65.49 |  −0.5% |
| Mixed negative Boolean              |   87.62 → 89.50 |  +2.1% |
| Absence phrase                      | 170.33 → 170.12 |  −0.1% |
| Burden phrase                       |   46.13 → 46.97 |  +1.8% |
| Statute of limitations / Rule 16    | 237.87 → 240.37 |  +1.1% |
| Zero-hit Second Amendment proximity | 295.44 → 307.24 |  +4.0% |

Requests-for-admission session means are 679.80–707.75 → 267.87–285.01 ms;
mandate rule 642.84–649.39 → 261.07–263.56 ms. These are repeatable large CPU
reductions. The other cases are near flat or slightly worse. The largest increase
is the zero-hit proximity case, with session means 278.70–312.18 → 294.52–319.96
ms. It already made zero origin reads in the previous profile and had little
checksum work to remove. There is no pruning or candidate-generation change
in this implementation. Small session ranges do not establish confidence
intervals or native Worker improvements.

All 320 measured CPU responses matched exactly between versions. The full
248-test repository suite passed. Seven focused packet/workerd tests also passed,
including the new missing-CRC-metadata and deliberately obsolete-checksum cases.
The local 160-contract source-oracle replay passed with no downloads. Removing
CRC intentionally changes byte-corruption detection; the tests now require
truncation and structural/generation failures rather than payload checksum errors.

## Full 180-query rerun

All 180 queries retain their exact pre-change complete-response hashes across
1,620 measured responses and 1,080 inspector responses. The new CPU profiles
contain zero CRC32 samples. Score postings and position integers decoded remain
identical for all queries and cache conditions. Forty-four queries still require
at least 50 score I/O phases; the two slowest retain 61 and 60 phases.

Across equally weighted per-query medians, before → after:

| Measurement, ms                            |       P50 |       P95 |           P99 |
| ------------------------------------------ | --------: | --------: | ------------: |
| No-delay process CPU                       |   69 → 75 | 180 → 172 |     853 → 359 |
| Reused application response                | 188 → 203 | 562 → 617 | 3,808 → 3,659 |
| Empty application / primed shared response | 199 → 224 | 854 → 857 | 4,930 → 4,635 |

These are scenario statistics from separate sessions, with three observations
per query/condition, not production traffic percentiles or reliable individual
query tails. The full-workload P50 and reused-memory P95 **regress** in this run;
CRC removal is not reported as a general latency win. They motivated the smaller
interleaved check below. The isolated-process comparison supports a large CPU
reduction in the checksum-heavy cases and near-flat behavior elsewhere; it does
not justify attributing every cross-session latency change to this code change.

| Full-workload query       | Reused application ms | Empty application ms |
| ------------------------- | --------------------: | -------------------: |
| Requests for admission    |         4,008 → 3,848 |        5,269 → 4,946 |
| Mandate rule              |         3,808 → 3,659 |        4,930 → 4,635 |
| Statute / Rule 16         |         1,886 → 1,834 |        3,183 → 3,021 |
| Zero-hit Second Amendment |             622 → 685 |            676 → 742 |

The top two reused-memory requests still transfer about 142/144 MB from origin
and 179/175 MB from shared cache, respectively. CRC removal leaves those reads
and the 900-operation shared budget in place. That explains why the large CPU
reduction produces much smaller complete-response gains on these scenarios.
After removal, the sampled engine work is led by column unpacking, search loops,
candidate selection, directory decoding and score-batch appends. Inspector
`post` overhead remains visible in short-query samples; those samples are not
used as process-CPU estimates.

## Randomized interleaved latency pilot

To check the separate-session results, both implementations then ran the same
eight queries in randomized order under the same simulated model, using separate
bounded application/shared caches and the completely frozen control runtime.
There were three repetitions/version/query in each condition: 96 measured
responses, with exact cross-version response hashes and no errors/downloads.
Unlike the per-query research profile, this pilot warms the shared query workload
in one pass and then interleaves queries. Its cache history and absolute timings
therefore differ. These are exploratory medians, not stable tail estimates.

| Query                     | Reused application ms | Empty application ms |
| ------------------------- | --------------------: | -------------------: |
| Requests for admission    |         3,776 → 3,370 |        3,721 → 3,448 |
| Mandate rule              |         3,226 → 2,922 |        3,195 → 2,883 |
| Statute / Rule 16         |         1,438 → 1,338 |        1,422 → 1,337 |
| Rules Boolean             |              101 → 97 |             98 → 108 |
| Burden phrase             |             201 → 204 |            214 → 215 |
| Mixed negative Boolean    |             240 → 241 |            243 → 236 |
| Absence phrase            |         1,151 → 1,215 |        1,192 → 1,221 |
| Zero-hit Second Amendment |             728 → 736 |            738 → 743 |

Requests for admission improves 10.7%/7.3%, mandate rule 9.4%/9.8%, and statute
7.0%/6.0%. There are remaining latency regressions: absence +5.5%/+2.4%, rules
empty-application +10.5%, burden +1.1%/+0.6%, and zero-hit Second Amendment
+1.1%/+0.8%. Mixed Boolean is near flat. The absence runs transfer more origin
pages after removal (median 62→72 reads reused, 64→74 empty), exposing the
operation-budget/cache-scheduling issue despite less checksum CPU. Rules has
zero origin reads in both versions; its small-sample timing change does not come
from saved checksum work. No workload-wide latency improvement is claimed.

Reproduce either condition with the archived CPU contract, for example:

```sh
CWS_CONTROL_SOURCE=work/cpu-control-19ea9da CWS_CONTROL_RUNTIME=frozen CWS_PAIR_INDEX=work/columnar-complete-pairs-1m CWS_PLANS=control-N100-M1000,auto-N100-M1000 CWS_SHARED_CACHE_MIB=1024 CWS_REPEATS=3 CWS_LABEL=no-crc-interleaved-reuse CWS_CONDITION=memory-reuse yarn node --import tsx bench/columnar/simulate.ts work/columnar-worker-stem-1m bench/results/columnar/no-crc-1m/cpu-contract.json
```

Set `CWS_CONDITION=shared-warm-memory-empty` and a distinct label for the second
condition. All measurements and profiles, including the full-workload
regressions, are archived in `results/columnar/no-crc-1m/`.

## Next bottleneck

CRC is absent from query execution. The next change should reduce repeated
physical page reads and the 60–61 score dependencies on candidate-filtered and
oversized queries, with bounded adaptive lookahead and batched candidate-window
reads. Track the shared GET/PUT budget explicitly: removing CPU checks does not
make repeated origin transfers or serial waves cheap. Retain absence and rules
as regression controls. Format, contexts and excerpts need no changes.
