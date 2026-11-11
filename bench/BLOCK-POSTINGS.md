# Block postings and skip pointers (v4 → v5)

Large lists restart every 256 documents. A checksummed skip directory supplies document boundaries, offsets, lengths and frequency/position CRCs. Small lists (at most 256 documents) keep the compact split-stream codecs. A required rare term can anchor Boolean, phrase and proximity queries; matching candidates seek relevant blocks in longer lists. Fragmented selections use at most four range windows per stream, decoding only selected blocks inside them. All query reads share concurrency four.

Every directory and embedded payload byte counts against the unchanged 8/16/32/48 MiB budget. Dictionaries and compressed document tables retain their v4 layouts. Remote sparse plans add a directory-prefix request and an anchor phase; broad queries and scattered matches can gain little or regress. Full scans use one range per stream. Exact totals, ranking and tie order are retained. Full generation rebuild required; v4 bundles are rejected by v5.

## Full matrix

24 freshly rebuilt configurations: seed 42, 10k/100k/1m documents, two embedding policies, four budgets. Twelve plain and seven connector queries, three passes each, top 20, IDs only. Local Node HTTP handler/filesystem measurements; not deployed Cloudflare/R2 latency. Construction records are in results/block-builds.json. The final query matrix reuses byte-verified indexes; build times/RSS are inherited from those fresh builds, and query timings/RSS are remeasured with the final code. Small query counts limit tail-latency confidence.

|Docs|MiB|Policy|Plain P95 ms before → after|Connector P95 ms before → after|Plain zero reads % before → after|Plain reads/query before → after|
|--:|--:|--|--:|--:|--:|--:|
|10000|8|smallest|4.01 → 3.96|7.53 → 9.27|100.0 → 100.0|0.00 → 0.00|
|10000|8|workload|4.70 → 5.79|5.25 → 8.23|100.0 → 100.0|0.00 → 0.00|
|10000|16|smallest|4.05 → 3.95|6.16 → 7.35|100.0 → 100.0|0.00 → 0.00|
|10000|16|workload|4.06 → 4.04|6.42 → 5.75|100.0 → 100.0|0.00 → 0.00|
|10000|32|smallest|4.27 → 3.98|7.35 → 8.11|100.0 → 100.0|0.00 → 0.00|
|10000|32|workload|4.09 → 3.89|5.42 → 10.33|100.0 → 100.0|0.00 → 0.00|
|10000|48|smallest|4.09 → 6.60|7.63 → 8.50|100.0 → 100.0|0.00 → 0.00|
|10000|48|workload|4.36 → 7.07|7.14 → 9.12|100.0 → 100.0|0.00 → 0.00|
|100000|8|smallest|15.32 → 17.42|30.02 → 35.28|25.0 → 25.0|1.08 → 1.33|
|100000|8|workload|15.69 → 23.07|30.92 → 38.08|100.0 → 100.0|0.00 → 0.00|
|100000|16|smallest|16.41 → 16.33|33.78 → 38.20|83.3 → 83.3|0.25 → 0.25|
|100000|16|workload|17.28 → 17.67|32.14 → 37.38|100.0 → 100.0|0.00 → 0.00|
|100000|32|smallest|15.97 → 16.45|31.18 → 29.16|100.0 → 100.0|0.00 → 0.00|
|100000|32|workload|21.41 → 17.00|31.90 → 30.78|100.0 → 100.0|0.00 → 0.00|
|100000|48|smallest|17.47 → 18.10|33.48 → 28.57|100.0 → 100.0|0.00 → 0.00|
|100000|48|workload|17.56 → 15.35|32.13 → 29.50|100.0 → 100.0|0.00 → 0.00|
|1000000|8|smallest|105.97 → 97.24|261.84 → 247.17|16.7 → 16.7|1.17 → 1.42|
|1000000|8|workload|95.06 → 97.51|278.98 → 258.08|58.3 → 58.3|0.50 → 0.67|
|1000000|16|smallest|98.21 → 101.20|255.43 → 263.37|16.7 → 16.7|1.17 → 1.42|
|1000000|16|workload|95.08 → 95.52|259.32 → 248.31|91.7 → 91.7|0.08 → 0.08|
|1000000|32|smallest|95.37 → 99.31|247.49 → 245.69|25.0 → 25.0|1.08 → 1.33|
|1000000|32|workload|92.09 → 96.89|268.55 → 259.29|100.0 → 100.0|0.00 → 0.00|
|1000000|48|smallest|92.69 → 97.52|242.17 → 251.89|25.0 → 25.0|1.08 → 1.33|
|1000000|48|workload|108.24 → 94.27|251.70 → 254.86|100.0 → 100.0|0.00 → 0.00|

## Alternating-order cross-format comparison

Preserved v4 indexes and the optimized v4 engine are compared to freshly built v5 indexes for identical ordered corpora. One warmup, three alternating-order measured passes. Every query must return identical IDs, exact scores and totals. The additional selective suite uses rare/common conjunctions, phrases and proximity queries and is reported separately from the original workload.

|Configuration|Suite|P50 ms before → after|P95 ms before → after|Mean reads before → after|Mean bytes before → after|
|--|--|--:|--:|--:|--:|
|100000-8-workload|plain|0.36 → 0.28|6.85 → 8.21|0.00 → 0.00|0 → 0|
|100000-8-workload|connectors|5.60 → 7.33|25.60 → 29.16|2.14 → 1.86|130761 → 133327|
|100000-8-workload|selective|3.66 → 1.08|4.01 → 1.58|1.20 → 0.60|60053 → 60588|
|1000000-48-workload|plain|1.54 → 1.71|71.75 → 79.17|0.00 → 0.00|0 → 0|
|1000000-48-workload|connectors|54.47 → 62.12|234.83 → 251.60|1.86 → 1.86|1305921 → 1331863|
|1000000-48-workload|selective|33.60 → 9.06|36.17 → 22.81|0.60 → 0.80|600004 → 613565|

At one million documents / 48 MiB, the paired selective suite reduces P50 by about 73% and P95 by about 37%. This is not a universal speedup: paired original plain P95 rises about 10%, and connector P95 about 7%. The synthetic rare-term hits are scattered, so coalesced positional reads transfer nearly whole lists; CPU decoding improves more than remote bytes. R2 request counts may increase for sparse remote plans. These local results do not predict production network latency.

### Selective query details (million documents / 48 MiB)

|Query|P50 ms before → after|Mean bytes before → after|
|--|--:|--:|
|`word19999 document`|22.12 → 6.48|0 → 0|
|`word19999 /s engine`|34.71 → 9.17|1000007 → 1021869|
|`"word19999 document"`|33.60 → 9.06|1000007 → 1021869|
|`word12345 AND search`|22.29 → 8.04|0 → 0|
|`word12345 /p document`|35.50 → 13.42|1000007 → 1024088|

## Size and resource tradeoffs

|Docs (48 MiB workload)|Frequency bytes before → after|Position bytes before → after|Bundle bytes before → after|
|--:|--:|--:|--:|
|10000|1598791 → 1616711|570740 → 572727|3205450 → 3225357|
|100000|15853116 → 16338622|4808712 → 4858057|22258523 → 22793374|
|1000000|158332692 → 165910369|47120790 → 48104449|50331365 → 50331431|

Build throughput, process peak RSS, query CPU and complete per-query diagnostics are recorded in results/results.json; construction RSS is not Worker isolate memory. Local actual-workerd startup/HTTP measurements are in WORKERD.md. No Cloudflare account deployment was performed.

Reproduce with `npm run check`, `npm test`, `npm run bench`, `node --import tsx bench/paired-blocks.ts`, `node --import tsx bench/runtime.ts`, then `python3 bench/blocks-report.py`. The paired run needs preserved v4 indexes at bench/generated/v4-100000-8-workload and v4-1000000-48-workload, built from the same seeded corpora at commit 1d4ba24. Frozen v4 engine/index readers are in baseline-v4-blocks/. Earlier paired scripts require their historical format generations.

Highest-value follow-ups: choose remote range windows using read/byte cost estimates, candidate-directed positions after full coarse evaluation, richer Boolean candidate plans, joint frequency/position embedding, and score-bound pruning for broad queries. The current working-set guard conservatively uses complete term sizes, so very large terms may still be rejected even if a sparse plan could fit.
