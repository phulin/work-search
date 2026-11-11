# Scoring-loop optimization

Precompute IDF per positive term, compile scoring entries in their original order, share field length normalization across terms, and avoid allocating heap hits for rejected candidates. BM25 floating-point operation order, exact totals, tie ordering, index format, and bundle bytes are preserved.

All 24 configurations rerun: 10k/100k/1m documents × 8/16/32/48 MiB × smallest/workload. Existing indexes are byte-verified and reused; build timings and construction memory are inherited, not remeasured. These are local Node/filesystem measurements, not deployed Cloudflare latency. The small synthetic workload limits tail-latency confidence.

## Matrix: plain queries

|Documents|MiB|Policy|P50 before → after ms|P95 before → after ms|CPU before → after ms/query|
|--:|--:|--|--:|--:|--:|
|10000|8|smallest|0.23 → 0.21|4.17 → 4.01|2.74 → 2.18|
|10000|8|workload|0.23 → 0.23|4.01 → 4.70|2.52 → 2.25|
|10000|16|smallest|0.30 → 0.25|4.73 → 4.05|3.07 → 2.54|
|10000|16|workload|0.30 → 0.25|4.75 → 4.06|2.97 → 2.62|
|10000|32|smallest|0.23 → 0.29|4.17 → 4.27|2.65 → 2.27|
|10000|32|workload|0.24 → 0.26|4.00 → 4.09|2.54 → 2.32|
|10000|48|smallest|0.22 → 0.34|4.08 → 4.09|2.37 → 2.27|
|10000|48|workload|0.24 → 0.25|4.07 → 4.36|2.67 → 2.67|
|100000|8|smallest|0.83 → 0.72|22.73 → 15.32|7.98 → 5.10|
|100000|8|workload|0.62 → 0.60|25.59 → 15.69|7.24 → 5.64|
|100000|16|smallest|0.65 → 0.67|22.64 → 16.41|6.96 → 6.50|
|100000|16|workload|0.64 → 0.61|21.96 → 17.28|7.05 → 5.68|
|100000|32|smallest|0.66 → 0.57|21.81 → 15.97|7.20 → 5.65|
|100000|32|workload|0.65 → 0.66|21.96 → 21.41|6.72 → 7.09|
|100000|48|smallest|0.66 → 0.65|21.94 → 17.47|6.83 → 6.17|
|100000|48|workload|0.64 → 0.66|22.06 → 17.56|6.75 → 5.98|
|1000000|8|smallest|5.05 → 3.81|146.09 → 105.97|39.64 → 28.66|
|1000000|8|workload|3.17 → 3.24|138.92 → 95.06|40.40 → 25.15|
|1000000|16|smallest|5.09 → 3.60|149.41 → 98.21|39.67 → 27.64|
|1000000|16|workload|7.71 → 2.94|213.42 → 95.08|45.38 → 25.55|
|1000000|32|smallest|4.48 → 3.12|136.45 → 95.37|36.93 → 26.19|
|1000000|32|workload|3.42 → 3.35|133.54 → 92.09|35.25 → 24.54|
|1000000|48|smallest|4.40 → 3.08|138.80 → 92.69|36.92 → 24.75|
|1000000|48|workload|3.69 → 4.00|136.94 → 108.24|35.79 → 24.83|

## Alternating-order paired comparison

One warmup and three measured passes on identical indexes compare the frozen previous scorer to the optimized scorer. Every returned ID, score, and exact count matches. Paired timing uses the search function directly; matrix timing includes the HTTP handler.

|Configuration|Suite|P50 before → after ms|P95 before → after ms|
|--|--|--:|--:|
|100000-8-workload|plain|0.54 → 0.51|12.00 → 6.70|
|100000-8-workload|connectors|5.59 → 5.55|35.38 → 24.17|
|1000000-48-workload|plain|5.14 → 4.51|127.72 → 73.03|
|1000000-48-workload|connectors|57.17 → 56.77|288.69 → 225.01|

Bundle sizes, generations, R2 requests, and R2 bytes are unchanged in every configuration. Plain queries still read zero positional bytes. Connector samples are included in results/results.json. Local workerd HTTP measurements are in WORKERD.md; they are not Cloudflare deployment measurements.

Reproduce: `npm test`, `npm run check`, `npm run bench -- --reuse-indexes`, `node --import tsx bench/paired-scoring.ts`, `node --import tsx bench/runtime.ts`, then `python3 bench/scoring-report.py`. Reuse requires matching previously constructed indexes; omit `--reuse-indexes` to build them first.
