# V5 block-decoder optimization

Index format, generation hashes, embedded bytes and configured budgets are unchanged. Full scans bypass sparse planning/scheduling; frequencies and absolute positional offsets decode directly into final arrays. Directory fields use scalar reads instead of temporary arrays. One-byte varints have an immediate fast path. Indexed checksum loops retain per-block CRCs. Selected blocks still validate canonical varints, sorted IDs/positions, stream binding, exact boundaries and trailing data. No posting cache or expanded index tables are added.

## Full 24-configuration matrix

10k/100k/1m documents × 8/16/32/48 MiB × smallest/workload. Twelve plain and seven connector queries, three passes each, top 20, IDs only, seed 42. Existing v5 indexes are byte-verified and reused. Construction time/RSS is inherited from the prior matching build, not remeasured. These are local Node HTTP/filesystem measurements, not deployed Cloudflare latency; small synthetic query sets limit tail confidence.

|Docs|MiB|Policy|Plain P95 ms before → after|Connector P95 ms before → after|CPU ms/query before → after|
|--:|--:|--|--:|--:|--:|
|10000|8|smallest|3.96 → 3.55|9.27 → 4.40|2.29 → 1.95|
|10000|8|workload|5.79 → 3.45|8.23 → 4.55|2.69 → 2.17|
|10000|16|smallest|3.95 → 3.50|7.35 → 4.91|2.17 → 2.02|
|10000|16|workload|4.04 → 3.56|5.75 → 8.80|2.09 → 2.23|
|10000|32|smallest|3.98 → 3.77|8.11 → 5.63|2.15 → 2.10|
|10000|32|workload|3.89 → 4.26|10.33 → 5.75|2.17 → 2.49|
|10000|48|smallest|6.60 → 4.32|8.50 → 7.24|2.59 → 2.52|
|10000|48|workload|7.07 → 3.49|9.12 → 4.74|2.85 → 2.08|
|100000|8|smallest|17.42 → 15.64|35.28 → 26.68|7.52 → 5.61|
|100000|8|workload|23.07 → 13.78|38.08 → 26.71|7.77 → 5.39|
|100000|16|smallest|16.33 → 13.95|38.20 → 25.95|6.13 → 5.77|
|100000|16|workload|17.67 → 14.79|37.38 → 28.98|6.52 → 5.89|
|100000|32|smallest|16.45 → 13.59|29.16 → 24.31|5.61 → 5.39|
|100000|32|workload|17.00 → 14.09|30.78 → 25.44|6.36 → 5.47|
|100000|48|smallest|18.10 → 13.33|28.57 → 24.64|6.23 → 5.32|
|100000|48|workload|15.35 → 14.19|29.50 → 24.19|5.47 → 5.42|
|1000000|8|smallest|97.24 → 77.75|247.17 → 218.19|28.97 → 19.61|
|1000000|8|workload|97.51 → 72.69|258.08 → 218.64|28.82 → 19.46|
|1000000|16|smallest|101.20 → 78.79|263.37 → 206.47|28.70 → 22.16|
|1000000|16|workload|95.52 → 81.62|248.31 → 224.75|26.13 → 20.00|
|1000000|32|smallest|99.31 → 76.41|245.69 → 225.12|29.91 → 20.05|
|1000000|32|workload|96.89 → 80.80|259.29 → 222.58|26.05 → 18.63|
|1000000|48|smallest|97.52 → 78.96|251.89 → 216.30|27.49 → 19.43|
|1000000|48|workload|94.27 → 81.46|254.86 → 215.42|23.65 → 17.85|

## Paired previous v5 → optimized v5 (identical index bytes)

One warmup, three alternating-order measured passes, same-process search calls. All IDs, exact scores and match counts must agree. The v5 comparison freezes the previous loader, directory parser, codecs and scorer; query parsing/positional evaluation are shared. The v4 comparison uses preserved v4 generations and the frozen v4 scorer/reader with the frozen pre-optimization codec. Local filesystem I/O, not Cloudflare network latency.

|Configuration|Suite|P50 ms before → after|P95 ms before → after|
|--|--|--:|--:|
|100000-8-workload|plain|0.30 → 0.23|7.67 → 6.32|
|100000-8-workload|connectors|6.27 → 4.45|30.08 → 21.09|
|100000-8-workload|selective|0.97 → 0.62|1.44 → 0.98|
|1000000-48-workload|plain|1.70 → 1.41|84.34 → 61.68|
|1000000-48-workload|connectors|61.97 → 43.91|242.37 → 213.26|
|1000000-48-workload|selective|9.53 → 5.55|13.20 → 8.76|

## Paired pre-block v4 → optimized v5 (regression recovery)

One warmup, three alternating-order measured passes, same-process search calls. All IDs, exact scores and match counts must agree. The v5 comparison freezes the previous loader, directory parser, codecs and scorer; query parsing/positional evaluation are shared. The v4 comparison uses preserved v4 generations and the frozen v4 scorer/reader with the frozen pre-optimization codec. Local filesystem I/O, not Cloudflare network latency.

|Configuration|Suite|P50 ms before → after|P95 ms before → after|
|--|--|--:|--:|
|100000-8-workload|plain|0.25 → 0.27|7.34 → 6.03|
|100000-8-workload|connectors|6.60 → 4.44|25.57 → 23.77|
|100000-8-workload|selective|3.42 → 0.60|3.57 → 0.96|
|1000000-48-workload|plain|1.46 → 1.44|72.25 → 56.29|
|1000000-48-workload|connectors|56.30 → 42.06|229.17 → 208.83|
|1000000-48-workload|selective|33.82 → 5.10|36.46 → 8.83|

## Decoder-only measurements

Preloaded encoded bytes eliminate filesystem/network reads and isolate full-list decoding. One warmup, five alternating-order measured passes. Indexed CRC loops and removal of temporary block structures are included; ranking and positional matching are excluded.

|Term|Positions|Median ms before → after|
|--|--|--:|
|document|False|23.34 → 14.30|
|document|True|37.56 → 22.81|
|search|False|24.95 → 13.97|
|search|True|38.89 → 24.30|
|word0|False|18.42 → 10.51|
|word0|True|38.27 → 24.67|

All 24 bundle hashes, sizes, generation IDs and plain-query I/O metrics match the previous v5 run. Actual local workerd results and startup wall measurements are in WORKERD.md; they do not measure Cloudflare account startup CPU or deployed R2 latency. Raw CPU, memory, per-query diagnostics and failures are in results/results.json. No Cloudflare deployment is claimed.

Reproduce: `npm run check`, `npm test`, `npm run bench -- --reuse-indexes`, `node --import tsx bench/profile-block-decoding.ts`, `node --import tsx bench/paired-block-decoding.ts`, `node --import tsx bench/paired-v4-decoding.ts`, `node --import tsx bench/runtime.ts`, and `python3 bench/decoding-report.py`. Reuse requires matching existing construction records; omit --reuse-indexes to construct indexes. The optional pre-block recovery comparison also needs the preserved v4 corpora/indexes described in BLOCK-POSTINGS.md.

Limitations: broad queries still decode and score exhaustively; sparse remote plans can add prefix reads and transfer gap bytes; the working-set guard remains conservative. This change does not alter those tradeoffs or add score-bound pruning.
