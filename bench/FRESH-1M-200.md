# 200 queries on the new 1M court-case index

The build is correct on the independent query checks, but search remains too slow
for full-corpus adoption. The primary cold pass measured **2.14 / 5.96 / 13.70 s**
at P50/P95/P99. Admission took 17.85 s and mandate 15.54 s. No search code changed
between the two passes.

## Measurements

| Cold live pass                                 | Requests / successes | Client P50 |    P95 |     P99 | Maximum |
| ---------------------------------------------- | -------------------: | ---------: | -----: | ------: | ------: |
| First, during cleanup and correctness checking |            200 / 198 |     2.54 s | 7.85 s | 14.63 s | 18.14 s |
| Primary, after background work finished        |            200 / 200 |     2.14 s | 5.96 s | 13.70 s | 17.85 s |

Percentiles in the first row cover successful responses only; the two HTTP 500
responses remain in the machine results. They had empty bodies and no joined tail
observations. Both queries succeeded in the primary pass. Account analytics
reported two unattributed exceptions and no resource-limit errors; this does not
establish the cause of those responses. They have not been explained or fixed.

These are scenario statistics from one client, with BOS reported for all 200
primary requests, not production traffic percentiles. The passes have different
background conditions and randomized orders, so their difference is not an engine
speedup. There are only 200 requests per pass. Resampling the primary query set
gives approximate 95% intervals of P50 1.93–2.28 s, P95 5.08–10.32 s, and P99
7.43–17.85 s; these describe uncertainty across this workload, not other regions
or future traffic.

| Primary workload class        | Successful queries |    P50 |    P95 |     P99 |
| ----------------------------- | -----------------: | -----: | -----: | ------: |
| Existing research queries     |                180 | 2.14 s | 5.76 s | 15.54 s |
| Additional unfamiliar queries |                 20 | 1.89 s | 7.84 s | 11.94 s |

| Primary pass work         |       P50 |       P95 |        P99 |
| ------------------------- | --------: | --------: | ---------: |
| Native Worker CPU         |    500 ms |  1,590 ms |   3,015 ms |
| Worker response wall time |  1,632 ms |  5,442 ms |  13,293 ms |
| R2 GETs                   |        63 |       197 |        391 |
| R2 bytes                  | 13.70 MiB | 77.57 MiB | 158.11 MiB |
| Score postings decoded    |   259,675 | 2,406,997 |  3,589,876 |
| Score I/O waves           |         7 |         8 |         14 |
| Positional I/O waves      |         9 |        33 |         77 |
| Result GETs               |         6 |        22 |         24 |
| Metadata/snippet time     |    142 ms |    424 ms |     652 ms |

All 200 primary requests have joined native CPU observations with outcome `ok`.
The maximum tracked active query buffers were 11.0 MiB, retained pages 12.0 MiB,
and retained decoded data 4.0 MiB. These are separate counters, not measurements
of total isolate peak memory or cumulative allocation. No controlled load test
or additional client region was run in this check.

## Remaining costs

| Query, abbreviated; full strings in results                     |  Client |    CPU | GETs |    MiB | Score / positional I/O waves |
| --------------------------------------------------------------- | ------: | -----: | ---: | -----: | ---------------------------: |
| Requests for admission + application of law / legal conclusions | 17.85 s | 4.38 s |  549 | 158.11 |                      44 / 88 |
| Mandate rule + discovery / law of the case + timeliness         | 15.54 s | 2.94 s |  391 | 188.03 |                      10 / 77 |
| Fair Housing Act + United States + private action / immunity    | 13.70 s | 3.05 s |  367 | 117.24 |                      37 / 91 |
| Under the circumstances + in light of                           | 11.94 s | 3.02 s |  456 | 188.83 |                      14 / 75 |
| Appeal bond + objector / access to courts + Rule 7              | 10.71 s | 2.74 s |  236 |  96.97 |                       8 / 50 |

The wave counters are not an additive measurement of the critical path. The
large transfers and repeated positional waits remain the principal opportunity;
CPU is also substantial on the worst queries. Admission decodes 5,009,641 score
postings. Presentation is a smaller cost here and was left unchanged.

An important construction gap remains: the new generation includes **47,958
selected pairs**, not the complete pair-membership/context index used in the
earlier local experiments. Only two primary queries decoded pair context, and
none used the complete membership path. Most phrase queries therefore still
depend on ordinary word positions. This is not the intended final coverage.

The next step is to make construction produce the complete pair data expected by
the existing phrase/Boolean planner, then repeat these measurements on this same
corpus before building the full corpus. These measurements do not establish how
much that will save; the candidate counts and remaining physical footprint must
be measured again. The two unexplained HTTP errors also need follow-up.

## Contract and correctness

- One million court cases; 2,503,094 terms; `nfkc-lower-porter2-v1` analysis.
- Generation `2a608b20c7d2c42f8310d1941e9216a1feb85c043b6bcf9cf069f26eac11f0dd`.
- Corpus identity `e942ddeee0a58f3445688d49c29941cfde3dfc76f890e8b00593cbdeedf6d4e7`.
- Worker `work-search-cws-fresh-1m-bench`, version
  `2948a2fa-283d-45bc-b0f3-b72e3be5f475`; engine checkout `e52ef05`.
- The existing expanded 200-query contract supplies query strings/options only.
  Its expected IDs belong to a different 1M corpus and were not reused as an oracle.
- Every timed request has exact totals **off**, metadata and snippets **on**,
  a unique shared-page namespace, and an in-request application-memory reset.
  No response cache. This does not force a new isolate or control R2 backend caches.
- Seeds 491732 and 831075 randomize the two passes. Requests within each driver
  are sequential. Background checking overlapped the first pass only.
- All 76 independent source-oracle contracts passed ranked IDs/order, scores,
  metadata, Boolean/field/phrase/proximity matching and pagination. Query DFs and
  global field totals were independently checked. Maximum relative score error: 0.
- All 198 queries successful in both passes returned matching IDs/order, metadata,
  snippets, and scores within the recorded numerical tolerance. This is repeatability,
  separate from the 76-query independent oracle.
- Formatting, TypeScript checking, and all 327 repository tests passed.

The index's posting/pair objects occupy 8.94 GB and document groups 8.57 GB.
The root and bundled directories are retained locally; remote data remain immutable.
Construction used the earlier Worker code recorded in the construction manifest;
the later ingestion CPU improvements were tested separately, not used mid-build.

## Cleanup and artifacts

Cleanup reclaimed **44.02 GiB locally**. It submitted **2,254,951 obsolete R2 keys**
for deletion; that includes already absent keys and is not an actual storage-byte
measurement. A scan of 131 retained roots protected 185,297 references. The cleanup
Worker also rejected those keys independently. All 8,847 objects needed by the
finished 1M index were present with expected sizes afterward.

Source archives, local source corpus, finished indexes, frozen control, and
benchmark/oracle evidence remain. Task outputs and old pair scratch files were
removed. The construction, oracle, and cleanup Workers were retired. The isolated
search benchmark Worker remains; the public demo was not changed.

[Machine results](results/columnar/fresh-1m-200/) contain both passes with CPU joins,
query definitions, health/version identities, counters, results, error records,
the independent oracle, construction logs/report, and cleanup receipts. The full
compressed deletion/retention lists remain under
`work/construction-cleanup-20261115/`; their digests are in `cleanup-audit.json`.

Reproduce a cold pass against the retained index:

```sh
CWS_VARIANTS=work-search-cws-fresh-1m-bench \
CWS_LABEL=fresh-1m-200-repeat CWS_DRIVER=bench/columnar/fresh-live.ts \
yarn node --import tsx bench/columnar/with-tail.ts \
  https://work-search-cws-fresh-1m-bench.phulin.workers.dev \
  work/construction-v3/pilot-1m-c \
  bench/results/columnar/position-batches-1m/expanded-200-contract.json.gz \
  work/construction-v3/repeat.json.gz
```
