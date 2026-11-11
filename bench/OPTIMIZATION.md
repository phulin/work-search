# Compressed-length access optimization

The previous compressed reader is preserved from commit 6799e3d in baseline-v2/, including raw matrix results and a frozen decoder used only for paired benchmarks. Production remains binary format v2: no index rebuild is required for an existing v2 deployment.

## Changes and resource bounds

- Cache the last 32-document block header in seven numeric scalars, so sorted scoring candidates reuse validated offsets, minima and widths. Public accesses still validate document IDs; block checksums and geometry remain validated before use.
- Return minima directly for constant columns; decode varying packed lengths with byte/bit operations instead of an exponentiation loop. Unaligned fields spanning five bytes and all 0–32-bit widths are tested.
- Reuse one caller-owned length-result object per search. Default public reads still return independent values; there is no decoded document array or per-block length cache.

All 24 regenerated index binaries have **identical SHA-256 hashes and byte lengths** to the original v2 builds. Remote object lists/hashes and average I/O are also identical. Budgets remain 8/16/32/48 MiB. The million-document document table remains 5.97 MiB (6.67 MiB with dictionary), and its validation bitmap remains 3,907 bytes. Only Worker code changes; its small code-size difference is captured by the Wrangler dry-run artifacts, within the existing code headroom.

## Paired length-access microbenchmark

One million accesses per sample, twelve measured samples, baseline/optimized order alternated, medians shown. Both readers use the same bytes in one process with warmed validation and JIT. Checksums of all returned lengths are verified equal. The varying-length fixture uses body lengths 0–1023 and title lengths 0–8; it is additional to the constant-length synthetic corpus. The microbenchmark uses the default allocating API for both readers; the query-only result-object reuse is not needed to obtain these figures.

| Lengths  | Access     | Before ms | After ms | Speedup |
| -------- | ---------- | --------: | -------: | ------: |
| constant | sequential |     19.66 |     4.58 |   4.30× |
| constant | strided    |     58.18 |    50.07 |   1.16× |
| varying  | sequential |    125.86 |    14.43 |   8.72× |
| varying  | strided    |    174.37 |    58.46 |   2.98× |

## CPU profile

A V8 sampling profile repeats the same four query types twelve times on the same 48 MiB workload-aware index. Self-samples attributed to document-table functions fell from 429/2293 to 66/2020. Inlining/JIT attribution makes these approximate, not exact function timers. Raw profiles are generated under ignored bench/generated/profiles/; the compact summary is checked in. Reproduce with:

```sh
mkdir -p bench/generated/profiles
node --cpu-prof --cpu-prof-dir=bench/generated/profiles --cpu-prof-name=before.cpuprofile --import tsx bench/profile.ts bench/generated/1000000-48-workload --baseline
node --cpu-prof --cpu-prof-dir=bench/generated/profiles --cpu-prof-name=after.cpuprofile --import tsx bench/profile.ts bench/generated/1000000-48-workload
npx tsx bench/profile-summary.ts
```

## Paired end-to-end comparison

Same process, identical immutable v2 indexes, alternating execution order, one unmeasured warmup per query and ten measured passes over twelve queries (120 samples per reader/configuration). Only the document-table reader differs: the frozen reader ignores the optional scratch result and returns its original independent object. Full results, scores, exact totals, and I/O counters are checked equal for every pair. These warm Node HTTP-handler/filesystem measurements reduce between-run noise; they still exclude actual Cloudflare and public-network latency.

| Million-doc configuration | Before P50 ms | After P50 ms | Before P95 ms | After P95 ms | P95 reduction | Before CPU ms/query | After CPU ms/query |
| ------------------------- | ------------: | -----------: | ------------: | -----------: | ------------: | ------------------: | -----------------: |
| 1000000-8-smallest        |          3.54 |         3.82 |        137.79 |       123.54 |         10.3% |               33.85 |              28.28 |
| 1000000-8-workload        |          2.11 |         2.14 |        142.04 |       125.80 |         11.4% |               35.26 |              30.22 |
| 1000000-16-smallest       |          3.76 |         4.04 |        141.26 |       125.66 |         11.0% |               34.34 |              29.13 |
| 1000000-16-workload       |          1.94 |         2.12 |        149.16 |       138.06 |          7.4% |               31.47 |              28.73 |
| 1000000-32-smallest       |          4.20 |         5.11 |        143.24 |       126.38 |         11.8% |               33.46 |              30.40 |
| 1000000-32-workload       |          2.15 |         2.02 |        140.31 |       124.99 |         10.9% |               30.48 |              26.31 |
| 1000000-48-smallest       |          5.34 |         5.80 |        145.05 |       132.13 |          8.9% |               33.42 |              31.01 |
| 1000000-48-workload       |          2.01 |         1.92 |        137.33 |       125.23 |          8.8% |               29.90 |              26.37 |

## Complete rebuilt matrix

Columns show previous v2 → optimized v2, with the same corpus seed, queries, three passes, top 20 and ID-only AND mode. These are separate runs, so timing differences also include scheduling, GC and host load; the paired measurements above are the stronger attribution check. Build timings and offline peak RSS are preserved in the raw data, but this reader-only change is not intended to improve the builder.

|    Docs | Budget MiB | Policy   |      P50 ms |          P95 ms |  CPU ms/query | Zero reads % (unchanged) | Reads/query (unchanged) |
| ------: | ---------: | -------- | ----------: | --------------: | ------------: | -----------------------: | ----------------------: |
|   10000 |          8 | smallest | 0.19 → 0.21 |     4.44 → 4.09 |   2.62 → 2.60 |                    100.0 |                    0.00 |
|   10000 |          8 | workload | 0.23 → 0.24 |     5.68 → 3.92 |   2.98 → 2.54 |                    100.0 |                    0.00 |
|   10000 |         16 | smallest | 0.21 → 0.21 |     4.50 → 4.31 |   2.91 → 2.60 |                    100.0 |                    0.00 |
|   10000 |         16 | workload | 0.23 → 0.22 |     4.36 → 4.43 |   2.74 → 2.83 |                    100.0 |                    0.00 |
|   10000 |         32 | smallest | 0.20 → 0.21 |     4.34 → 4.23 |   2.66 → 2.43 |                    100.0 |                    0.00 |
|   10000 |         32 | workload | 0.23 → 0.20 |     4.35 → 3.85 |   2.71 → 2.47 |                    100.0 |                    0.00 |
|   10000 |         48 | smallest | 0.23 → 0.23 |     4.56 → 3.84 |   2.73 → 2.44 |                    100.0 |                    0.00 |
|   10000 |         48 | workload | 0.21 → 0.21 |     6.09 → 4.21 |   2.95 → 2.54 |                    100.0 |                    0.00 |
|  100000 |          8 | smallest | 0.72 → 0.79 |   23.00 → 21.65 |   8.33 → 7.91 |                     25.0 |                    1.08 |
|  100000 |          8 | workload | 0.63 → 0.63 |   22.97 → 20.52 |   8.10 → 7.68 |                    100.0 |                    0.00 |
|  100000 |         16 | smallest | 0.64 → 0.82 |   22.88 → 28.00 |   8.23 → 9.30 |                     91.7 |                    0.17 |
|  100000 |         16 | workload | 0.62 → 0.65 |   21.84 → 22.06 |   7.89 → 7.99 |                    100.0 |                    0.00 |
|  100000 |         32 | smallest | 0.63 → 0.65 |   21.83 → 21.58 |   7.83 → 7.86 |                    100.0 |                    0.00 |
|  100000 |         32 | workload | 0.63 → 0.77 |   22.40 → 21.95 |   7.84 → 8.30 |                    100.0 |                    0.00 |
|  100000 |         48 | smallest | 0.65 → 0.64 |   21.86 → 21.23 |   7.79 → 7.66 |                    100.0 |                    0.00 |
|  100000 |         48 | workload | 0.63 → 0.64 |   22.12 → 29.05 |   7.83 → 8.51 |                    100.0 |                    0.00 |
| 1000000 |          8 | smallest | 4.99 → 5.41 | 147.20 → 135.33 | 40.02 → 39.80 |                     16.7 |                    1.17 |
| 1000000 |          8 | workload | 3.73 → 3.57 | 143.51 → 128.44 | 40.40 → 35.14 |                     58.3 |                    0.50 |
| 1000000 |         16 | smallest | 4.38 → 4.37 | 137.92 → 128.80 | 39.58 → 35.92 |                     16.7 |                    1.17 |
| 1000000 |         16 | workload | 3.01 → 3.63 | 147.72 → 129.59 | 38.32 → 35.35 |                     91.7 |                    0.08 |
| 1000000 |         32 | smallest | 3.25 → 4.40 | 143.08 → 143.38 | 38.86 → 36.93 |                     25.0 |                    1.08 |
| 1000000 |         32 | workload | 2.99 → 3.60 | 141.19 → 119.78 | 36.12 → 30.96 |                    100.0 |                    0.00 |
| 1000000 |         48 | smallest | 4.43 → 5.64 | 143.31 → 126.27 | 39.48 → 37.54 |                     25.0 |                    1.08 |
| 1000000 |         48 | workload | 2.96 → 3.08 | 142.06 → 132.65 | 37.06 → 31.96 |                    100.0 |                    0.00 |

## Original regression at 48 MiB

| Policy   | Uncompressed v1 P95 ms | Original compressed v2 P95 ms | Optimized compressed v2 P95 ms |
| -------- | ---------------------: | ----------------------------: | -----------------------------: |
| smallest |                 125.43 |                        143.31 |                         126.27 |
| workload |                 136.92 |                        142.06 |                         132.65 |

Measured query failures: 0. The workload-aware policy remains evaluated on its training queries and is optimistic. The fixed twelve-query synthetic suite has limited tail-latency confidence; no real-world corpus or deployed Cloudflare account was used. See WORKERD.md for actual local Worker HTTP/startup results, results/paired.json and results/length-access.json for paired samples, results/optimization.json for artifact invariance checks, and results/bundle-dry-run.txt for the largest Worker artifact.
