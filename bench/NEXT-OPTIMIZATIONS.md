# Seven sequential optimization experiments

All measurements are local, on the same synthetic corpus; none are deployed Cloudflare/R2 latency. Budgets remain 8/16/32/48 MiB. No workload-selected phrase accelerators were implemented.

## Method
Eight separate cumulative runs: baseline plus each change, in the requested order. Each run covers one million documents, four budgets, 12 plain and seven connector queries, top 20, default total=false, one empty-runtime-cache pass then three repeated passes per query. These are 304 timed searches per stage (2,432 total), each checked against exact IDs and scores from the frozen exhaustive v5 engine on the original index. Cold means the application cache is empty; OS caches and document validation may already be warm. Warm repeats deliberately assume locality. Small samples and fixed stage order make small differences noisy; these are observations, not confidence intervals.

The final matrix adds 10k/100k/1m documents × four budgets × frequency-first/joint embedding, with both policies trained on the same mixed workload. It is not a held-out policy experiment. Each final configuration has 76 searches, 1,824 total. Conversion/repacking timings are not ingestion throughput. The original v6 million-document corpus build took 78.93 seconds; later stages convert encoded streams offline. Final Worker tests use real local workerd with Miniflare R2, not public HTTP storage.

## Million documents, 48 MiB: cache-warm

|Cumulative stage|Plain P50 ms|Plain P95 ms|Connector P50 ms|Connector P95 ms|
|---|---|---|---|---|
|Baseline|0.17|27.22|46.71|49.72|
|1. Scoring seeks|0.25|27.72|47.18|49.54|
|2. Score before positions|0.27|27.10|44.01|49.50|
|3. Adaptive bounds|0.17|26.85|36.38|49.66|
|4. Persisted bounds / block cursors|0.44|27.40|41.50|54.20|
|5. Adaptive position seeks|0.45|27.66|39.99|50.89|
|6. Block/directory/range cache|0.35|28.70|37.88|50.27|
|7. Packed/constant columns|0.33|25.59|38.55|49.67|

## Million documents, 48 MiB: cache-cold

|Cumulative stage|Plain P50 ms|Plain P95 ms|Connector P50 ms|Connector P95 ms|
|---|---|---|---|---|
|Baseline|1.14|45.51|53.93|63.73|
|1. Scoring seeks|1.35|46.09|59.24|66.44|
|2. Score before positions|1.20|47.58|49.17|62.67|
|3. Adaptive bounds|1.15|45.27|42.32|62.19|
|4. Persisted bounds / block cursors|1.11|28.29|52.28|80.91|
|5. Adaptive position seeks|1.07|29.19|41.90|79.74|
|6. Block/directory/range cache|1.12|29.81|47.57|78.22|
|7. Packed/constant columns|1.10|28.73|51.36|68.93|

## Interpretation
The clearest gain is cold broad plain-query execution from persisted bounds and block cursors. Warm connector median improves overall, while its tail is essentially flat. Some individual stages regress latency; the table retains those outcomes. Scoring seeks alone are not a statistically established improvement on this small suite. Cheap plain-query warm medians regress slightly in absolute terms, despite improved cold tail latency.

Initial always-on position seeks and generic packed decoding regressed: see next-5-initial.json through next-7-initial.json. The final encoder reserves seek tables for blocks averaging over four positions per row, retains legacy sparse positions, and uses native fills/arithmetic runs for constant frequency/document-gap columns. Caching excludes oversized local scans; remote cache misses retain one full frequency read to avoid many small requests.

## Dense positional workload
A separate 32,768-document corpus repeats three terms 64 times per document (192 positions). Three phrase/proximity queries run five passes with alternating variant order and exact result equality. After the first pass, legacy positional median is 16.08 ms versus 10.76 ms with seek tables. Both use identical frequency encoding and an 8 MiB budget. This targets the dense case selected by the adaptive encoder; raw samples are in results/next-dense.json.

## Final matrix

|Docs|MiB|Policy|Zero reads %|Reads/query|Bytes/query|Warm P50 ms|Warm P95 ms|
|---|---|---|---|---|---|---|---|
|10000|8|frequency|100.00|0.00|0|0.21|1.40|
|10000|16|frequency|100.00|0.00|0|0.16|0.79|
|10000|32|frequency|100.00|0.00|0|0.14|0.74|
|10000|48|frequency|100.00|0.00|0|0.11|0.75|
|10000|8|mixed|100.00|0.00|0|0.25|1.18|
|10000|16|mixed|100.00|0.00|0|0.15|0.90|
|10000|32|mixed|100.00|0.00|0|0.14|0.89|
|10000|48|mixed|100.00|0.00|0|0.23|1.35|
|100000|8|frequency|93.42|0.16|12238|0.72|4.37|
|100000|16|frequency|100.00|0.00|0|0.68|4.44|
|100000|32|frequency|100.00|0.00|0|0.55|2.96|
|100000|48|frequency|100.00|0.00|0|0.57|3.81|
|100000|8|mixed|100.00|0.00|0|0.68|4.41|
|100000|16|mixed|100.00|0.00|0|0.70|4.51|
|100000|32|mixed|100.00|0.00|0|0.58|2.95|
|100000|48|mixed|100.00|0.00|0|0.55|2.94|
|1000000|8|frequency|61.84|0.97|628716|17.73|52.46|
|1000000|16|frequency|72.37|0.49|482495|12.31|51.45|
|1000000|32|frequency|72.37|0.50|482504|9.26|50.56|
|1000000|48|frequency|72.37|0.49|482495|10.33|50.59|
|1000000|8|mixed|63.16|0.91|627898|17.51|50.05|
|1000000|16|mixed|100.00|0.00|0|11.88|50.55|
|1000000|32|mixed|100.00|0.00|0|8.45|50.49|
|1000000|48|mixed|100.00|0.00|0|8.71|49.98|

## Storage, memory and runtime
Million-document frequency postings shrink from 165,910,369 to 79,438,940 bytes (52.1%); positional bytes stay 48,104,449. The 48 MiB Wrangler dry run passes: 49,235.71 KiB total upload / 35,619.18 KiB gzip. This is a local packaging check, not deployed account validation. All 24 final bundles fit their budgets. Exact dictionary, frequency, positional, bundle and total stored bytes are in results/next-storage.json. Per-query CPU, request/byte counts, RSS and heap observations are in the stage/matrix JSON. Peak RSS is a Node benchmark-process observation, including oracle/index fixtures and OS allocator retention; it is not Worker isolate memory. Cache capacity remains 4 MiB, with query-headroom trimming. No Cloudflare isolate CPU/memory claim follows from host RSS.

|Local workerd configuration|Process/isolate startup wall ms|HTTP P50 ms|HTTP P95 ms|Failures|
|---|---|---|---|---|
|next-7r-8|159.66|42.32|65.55|0|
|next-7r-16|69.82|28.16|56.23|0|
|next-7r-32|97.52|26.16|53.33|0|
|next-7r-48|115.26|26.94|51.59|0|

Workerd runs 96 timed HTTP requests plus 32 exhaustive checks. Results/scores must match exactly within workerd; the separate Node oracle uses a 1e-12 score tolerance across runtimes. Startup includes local process launch/IPC and is not deployed startup CPU.

## Reproduction
```sh
npm test
npm run check
# Retain the previous release's benchmark fixtures for the historical baseline.
node --import tsx bench/next-prepare.ts
for stage in 0 1 2 3 4 5 6 7; do node --import tsx bench/next.ts "$stage"; done
node --import tsx bench/next-matrix.ts
node --import tsx bench/next-worker.ts
node --import tsx bench/next-dense.ts
python3 bench/next-report.py
```
The internal optimizationStage switch is never exposed by HTTP. Running npm run bench with the current writer creates current-format fixtures, not the historical v5 bytes used in this report; preserve those fixtures or regenerate them using the preceding release.

## Limits
Direct block execution supports positive Boolean term trees; phrases, negation, metadata and exact-total requests use the established executor. AND aligns cursors; positive OR trees use a block-max union iterator, not pivot-WAND. Broad remote streams still use full frequency reads, so decoding/memory improvements do not imply fewer R2 bytes. Position seek tables avoid semantic scans but keep block CRC reads. The fixed 4 MiB cache does not bound simultaneous query working sets. No phrase accelerators, document reordering or scoring changes were added. v8 builds require a new immutable generation; current readers also support v5–v7.

Timing audit after publication: the historical Node wall-clock samples above
include result-comparison and memory-sampling overhead. CPU counters stop before
those operations. The current harness excludes them; the historical JSON has not
been rewritten. Prefer the separately labeled Free Law Project benchmark for
measurements using the corrected timing boundary.
