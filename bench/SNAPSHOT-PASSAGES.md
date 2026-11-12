# Snapshot statistics and targeted excerpts

Implemented and measured cumulatively on the same frozen **2,866,398 opinions,
67 partitions, 8-MiB leaf bundles**. All 384 local responses and 288 native
responses preserve result IDs, scores (relative tolerance 1e-11), and local
result-card legal fields. Native result cards are exercised through actual R2.

## Native Cloudflare comparison

Six passes of 16 legal scenarios, with all six permutations of the three variant
orders balanced for each query. These are warmed repeated scenario queries, not
production traffic. Each variant has 96 observations; P95 is nearest rank.
The variants share leaf Workers and backend warmth; isolate placement and R2
cache state are uncontrolled. Private gateway traces count gateway I/O only.

| Variant                      |    P50 |    P95 |
| ---------------------------- | -----: | -----: |
| Previous design              | 0.570s | 1.428s |
| + pinned corpus statistics   | 0.596s | 1.516s |
| + adaptive targeted excerpts | 0.473s | 1.156s |

Combined warmed native improvement: **17% P50, 19% P95**. Snapshot statistics alone
regressed aggregate P50 about 5% and P95 about 6%; removing coordination does not
establish an end-to-end latency win on this already hot dictionary workload.
The final pass alone was 726/1927 ms, 543/1157 ms, and 238/1156 ms respectively.
That much larger final-pass difference must not replace the aggregate result.
An earlier three-pass pilot was mixed (aggregate previous: 514/1475 ms, snapshot:
581/1273 ms, excerpts: 646/1745 ms), reinforcing the cache sensitivity.

## Local simulation

Production gateway/shard handlers and original mirrored bytes, using the existing
empirical R2 header/body distributions. Each variant has reset-cache scenarios
and three repeated passes for repeated-range and varied-range distributions.
Below is the final repeated pass, 16 scenarios per row (P95 is the maximum).

| Variant | Repeated P50/P95 |  Varied P50/P95 | Mean graph R2 reads (repeated/varied) |
| ------- | ---------------: | --------------: | ------------------------------------: |
| 3       |  0.912s / 2.828s | 1.616s / 5.556s |                         80.69 / 80.81 |
| 4       |  0.914s / 2.786s | 1.626s / 5.896s |                         80.13 / 80.19 |
| 5       |  0.886s / 2.716s | 1.595s / 5.515s |                         80.38 / 80.00 |

Local overall median/tail changes are small. Statistics service calls fall from
**70 to zero per query** across the graph; most previously used hot dictionaries
and performed no R2 reads themselves. Local mean consumed bytes remain about
8.2–8.3 MB/query, dominated by index I/O rather than excerpts. Reset-cache rows,
CPU, RSS and every query are in the machine-readable results. Aggregate Node CPU
and RSS are not per-isolate Worker CPU/memory. The full import and the directory
refresh ran during parts of the sequential simulation; host contention is an
additional confound. This does not establish an overall CPU improvement.

## What changed and what is deployed

1. Route roots carry matching corpus totals and hot-term global DFs. Rare-term
   DFs come from directory pages. Dedicated immutable routers pin the exact
   generation vector; live/unpinned gateways retain the safe fallback.
2. Independently gzipped text frames have term Bloom filters, exact verification,
   checksums and generation checks. At >=32 KiB compressed body size, level 5 can
   read matching chunks instead of decompressing from the opinion's beginning.
   Smaller bodies use the original streamed read. Decoded frames/directories use
   a bounded 2-MiB cache. First-chunk prefix reads happen only when needed.

The complete directory refresh covers **7,026,375 opinions / 185 partitions**:
**437,479 bundled root bytes** and **1,437,451,021 remote directory bytes** in 22
objects. It was built and uploaded separately from the frozen benchmark.
The 8-MiB leaf index budgets and bundle bytes are unchanged.

The separately deployed [snapshot demo](https://work-search-snapshot.phulin.workers.dev/)
uses level 4 by default; the growing demo is independent. Level 5 remains opt-in
because excerpt improvements are cache-sensitive and the existing corpus has not
received a complete passage backfill. All new input-card builds support passages.

For the frozen experiment only, passages were backfilled for all **323 recorded
result documents**, whose original compressed bodies total 2,720,701 bytes. Card
and passage objects total 451,886,522 bytes, mostly existing legal cards. These
fixtures are selected to cover the benchmark, not a full-corpus storage or hit-rate
estimate. A full passage backfill requires additional R2 storage and build/upload
time; full opinion viewer data is retained. No workload-selected phrase
accelerator was introduced.

Validation: **160 tests pass**, including real workerd/R2 snapshot tests, Unicode
normalization, late-match chunk reads, CRC/generation corruption, immutable-root
fallback, deterministic route builds and existing pagination checks. Type checking
passes. See [operations](../demo/README.md), [format](../docs/FORMAT.md), and
[all measured rows and summaries](results/demo-next.json).

Reproduce using `bench/demo-next-local.ts`, `bench/demo-next-native.ts`, and
`bench/demo-next-report.ts` with Node/tsx. The native runner uploads the frozen
passage fixture, deploys private probes, then runs six balanced passes; use
`--run-only` to retain deployed variants. Full directory publication uses
`npm run publish-search-snapshot`.

## Larger snapshot smoke checks

The separate 7.03M-opinion snapshot returned valid legal cards and five distinct
second-page results for each of three searches. Client first-page times were
0.929s for `summary judgment`, 2.692s for `Christenberry Allen`, and 7.728s for
`"clear and convincing evidence"`; an earlier first observed summary query took
4.345s. These are operational smoke checks with limit 5, uncontrolled warmth,
and no matched baseline, not a seven-million-document performance comparison.
The frozen 2.87M-opinion latency table must not be applied to this larger site.
Exact full-directory objects and shard generations are in
[the directory manifest](results/demo-next-directory.json).
