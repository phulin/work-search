# Phrase and proximity execution optimization

The original v3 matcher and search engine are frozen from a68426a in baseline-v3/, together with the original raw measurements. The index format remains v3; **no index rebuild is required** to deploy this optimization. All 24 index bundles and R2 object lists have identical byte sizes and SHA-256 hashes. Budgets, embedding decisions, exact match counts and I/O remain unchanged.

## Execution changes

- Compile the query into query-local plans once. Numeric epoch stamps replace per-candidate Map clears and repeated AST/string lookups.
- Reuse bounded per-term body/title position buffers. Positions are read from validated immutable bytes, with a one-byte varint fast path; sparse candidates use galloping/binary document seeking. There is no corpus-wide expanded position cache.
- Phrase existence uses the shortest position list as its anchor, advancing monotone cursors across the other words and stopping at the first match. Repeated words retain their distinct phrase offsets.
- Proximity existence uses ordered interval sweeps; nonmonotone nested interval ends use lower-bound searches. Nested expressions retain every needed match, using windowed joins rather than all Cartesian pairs. Sorted OR spans are merged and deduplicated.
- Materialize compound spans only when a parent needs locations. Cheap Boolean/exclusion filters run before expensive positional predicates when safe. Exact totals are still computed by examining the complete candidate set.

Every access retains bounds/corruption validation from decodePostings. Scratch is per query, within the existing 56 MiB working-set cap and bundle-dependent guard. Per-term retained body/title peaks plus growth are charged conservatively. Each materialized compound buffer is capped at 4,096 spans and query-wide retained compound capacity at 32,768 spans; the ten-million comparison/check budget remains. Dense simple phrases/proximity can now succeed without expanding thousands of span objects. Genuine resource exhaustion returns 503, never truncated matches.

## Complete matrix, connector suite

Same seed-42 corpora, seven connector queries × three passes, all 8/16/32/48 MiB budgets and both policies. Indexes were **reused and byte-verified**, because this is an execution-only change. All query timing/CPU/RSS measurements are fresh child-process measurements. Index construction timing/throughput/RSS are inherited from the original v3 builds and are explicitly not remeasured. New query-only process peak RSS must not be compared directly to old combined build+query process peak RSS. No runtime memory reduction is inferred from that difference.

These are local Node HTTP-handler/filesystem measurements, not deployed Cloudflare latency. Separate runs can be affected by host load, JIT and GC; paired measurements follow.

|    Docs | Budget MiB | Policy   | Before P50 ms | After P50 ms | Before P95 ms | After P95 ms | Speedup P95 | Before CPU ms/query | After CPU ms/query |
| ------: | ---------: | -------- | ------------: | -----------: | ------------: | -----------: | ----------: | ------------------: | -----------------: |
|   10000 |          8 | smallest |          1.00 |         0.99 |          9.14 |         6.33 |       1.44× |               12.12 |               5.88 |
|   10000 |          8 | workload |          1.01 |         1.07 |          9.46 |         6.40 |       1.48× |               11.57 |               8.00 |
|   10000 |         16 | smallest |          1.03 |         0.97 |          8.87 |         6.04 |       1.47× |               11.27 |               7.43 |
|   10000 |         16 | workload |          1.03 |         1.03 |          9.44 |         6.52 |       1.45× |               12.43 |               6.16 |
|   10000 |         32 | smallest |          1.01 |         1.04 |          9.59 |         7.11 |       1.35× |               11.33 |               6.86 |
|   10000 |         32 | workload |          0.98 |         1.05 |          9.09 |         6.10 |       1.49× |               11.39 |               7.71 |
|   10000 |         48 | smallest |          1.01 |         1.05 |          9.06 |         6.57 |       1.38× |               12.10 |               7.82 |
|   10000 |         48 | workload |          1.02 |         1.00 |          9.45 |         6.01 |       1.57× |               11.66 |               7.40 |
|  100000 |          8 | smallest |          7.40 |         7.02 |         73.52 |        38.93 |       1.89× |               48.34 |              26.72 |
|  100000 |          8 | workload |          8.89 |         9.41 |         67.06 |        40.27 |       1.67× |               38.28 |              27.94 |
|  100000 |         16 | smallest |          9.29 |         6.76 |         68.59 |        38.40 |       1.79× |               40.71 |              26.39 |
|  100000 |         16 | workload |          9.00 |         6.88 |         66.74 |        37.32 |       1.79× |               38.05 |              24.77 |
|  100000 |         32 | smallest |          8.14 |         6.93 |         64.81 |        35.57 |       1.82× |               38.90 |              25.46 |
|  100000 |         32 | workload |          8.19 |         6.72 |         65.49 |        37.02 |       1.77× |               36.92 |              26.02 |
|  100000 |         48 | smallest |          8.13 |         6.89 |         66.23 |        35.46 |       1.87× |               36.64 |              25.69 |
|  100000 |         48 | workload |          8.11 |         6.70 |         66.17 |        35.81 |       1.85× |               39.10 |              26.19 |
| 1000000 |          8 | smallest |         74.67 |        60.21 |       1130.42 |       307.61 |       3.67× |              623.36 |             160.45 |
| 1000000 |          8 | workload |         74.27 |        57.04 |        900.20 |       295.36 |       3.05× |              700.93 |             158.32 |
| 1000000 |         16 | smallest |         74.02 |        58.77 |        913.08 |       303.13 |       3.01× |              614.39 |             158.36 |
| 1000000 |         16 | workload |         70.62 |        60.51 |        725.83 |       309.80 |       2.34× |              426.57 |             158.08 |
| 1000000 |         32 | smallest |         75.84 |        57.80 |        891.70 |       307.54 |       2.90× |              699.43 |             159.64 |
| 1000000 |         32 | workload |         91.88 |        55.61 |        794.59 |       316.04 |       2.51× |              449.53 |             160.40 |
| 1000000 |         48 | smallest |         73.52 |        59.56 |        894.61 |       303.17 |       2.95× |              664.78 |             156.39 |
| 1000000 |         48 | workload |         74.65 |        58.07 |        830.63 |       306.86 |       2.71× |              479.55 |             156.94 |

## Paired million-document comparison

Same process and immutable bytes, alternating execution order, one unmeasured warmup per query and five measured passes (35 samples per variant/configuration). Exact result IDs, scores, total counts and index/metadata I/O are checked equal for every pair.

| Configuration       | Before P95 ms | After P95 ms | Speedup |
| ------------------- | ------------: | -----------: | ------: |
| 1000000-8-smallest  |        778.57 |       263.00 |   2.96× |
| 1000000-8-workload  |        782.54 |       270.58 |   2.89× |
| 1000000-16-smallest |        825.50 |       267.11 |   3.09× |
| 1000000-16-workload |        826.82 |       273.06 |   3.03× |
| 1000000-32-smallest |        813.34 |       270.59 |   3.01× |
| 1000000-32-workload |        841.14 |       266.44 |   3.16× |
| 1000000-48-smallest |        815.06 |       271.15 |   3.01× |
| 1000000-48-workload |        861.69 |       268.41 |   3.21× |

## Profiling

V8 CPU profiles use the same 48 MiB workload-aware index and four passes over three common positional queries. The original profile showed substantial typed-array allocation in postingPositions. Reproduce the profiles with `node --cpu-prof --cpu-prof-dir=bench/generated/profiles --cpu-prof-name=connectors-before.cpuprofile --import tsx bench/profile-connectors.ts --baseline` and the corresponding `connectors-after.cpuprofile` command without `--baseline`, then run `node --import tsx bench/profile-positional-summary.ts`. Compact self-sample data is in results/positional-profile.json. Inlining, JIT and GC affect attribution; these are not precise function timers. Raw profiles remain under ignored bench/generated/profiles/.

## Reproduction

```sh
npm test
# Regenerate identical corpora/indexes if bench/generated is absent:
npm run bench
# Rerun query execution against existing verified indexes:
npm run bench -- --reuse-indexes
node --import tsx bench/paired-connectors.ts
node --import tsx bench/runtime.ts
node --import tsx bench/bundle.ts
node --import tsx bench/positional-optimization-report.ts
```

Reuse mode requires the default configurations and a68426a baseline measurements in baseline-v3/. For custom corpora/configurations, use a fresh build. Raw current samples are in results/results.json and results/paired-connectors.json; artifact/count/I/O invariance checks are in results/positional-optimization.json. Local workerd HTTP/startup results are in WORKERD.md; the actual largest Worker artifact is recorded in results/bundle-dry-run.txt.

The suite is small and synthetic, and workload-aware embedding is still trained on the original plain-term workload. Connector queries are not part of that training. Tail percentiles have limited statistical confidence; broad queries still exhaustively score many candidates, and uncommon nested conjunctions may hit bounded span expansion. No Cloudflare deployment or production latency/memory measurements were performed.
