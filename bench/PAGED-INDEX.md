# R2-backed paged index: 100,000 Free Law Project decisions

Local Node/filesystem simulation. Fixed latency is added to every actual storage read; concurrent requests overlap. These are not deployed Cloudflare latency measurements. The model has no jitter, bandwidth limit, packet loss, or location effects. Timer scheduling can exceed the requested delay.

## Method

The frozen 160-query evaluation workload contains 40 plain, 40 Boolean, 40 phrase, and 40 proximity queries. All searches request the best 20 IDs/scores with exact totals disabled. Every timed result is checked against the existing exhaustive executor after timing. The baseline uses the existing 32/48 MiB mixed-policy generations. The paged generation uses identical posting codecs, document order, statistics, and scoring, and embeds no postings or term descriptors. The 8/16 MiB bundled baselines remain infeasible (30.2 MiB mandatory data); one identical paged root fits every budget, so it is measured once rather than relabeled four times.

Cold means a fresh empty 4 MiB engine cache for every query. Mixed means two sequential workload passes sharing a 4 MiB cache; it includes the initial cold pass. OS file caches may be warm. Each design/delay combination runs in a separate child process. Correctness references are loaded from a small setup file, without retaining the baseline index in paged benchmark processes. Memory is sampled process RSS after queries, not peak isolate memory. CPU is process CPU consumed during the timed query. Startup includes local file loading and index construction, not Cloudflare startup CPU.

## Results

| Design | Added ms/read | Cache | P50 ms | P95 ms | CPU ms/query | Reads/query | KiB/query | Zero reads |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 32-mixed | 0 | cold | 7.39 | 38.43 | 17.16 | 3.61 | 1349.1 | 6.9% |
| 32-mixed | 0 | mixed | 6.30 | 35.34 | 12.07 | 3.57 | 1343.1 | 6.9% |
| 32-mixed | 5 | cold | 13.76 | 49.32 | 18.79 | 3.61 | 1349.1 | 6.9% |
| 32-mixed | 5 | mixed | 13.77 | 50.17 | 15.63 | 3.57 | 1343.1 | 6.9% |
| 32-mixed | 20 | cold | 32.38 | 132.64 | 23.68 | 3.61 | 1349.1 | 6.9% |
| 32-mixed | 20 | mixed | 30.04 | 119.22 | 17.01 | 3.55 | 1333.3 | 6.9% |
| 48-mixed | 0 | cold | 7.27 | 38.77 | 17.70 | 2.75 | 1204.1 | 13.8% |
| 48-mixed | 0 | mixed | 6.61 | 38.28 | 13.46 | 2.74 | 1204.0 | 13.8% |
| 48-mixed | 5 | cold | 13.70 | 44.60 | 19.10 | 2.75 | 1204.1 | 13.8% |
| 48-mixed | 5 | mixed | 13.07 | 47.55 | 15.28 | 2.74 | 1204.0 | 13.8% |
| 48-mixed | 20 | cold | 30.36 | 104.49 | 21.06 | 2.75 | 1204.1 | 13.8% |
| 48-mixed | 20 | mixed | 29.78 | 110.20 | 19.57 | 2.73 | 1199.1 | 13.8% |
| paged | 0 | cold | 15.93 | 48.06 | 28.12 | 18.12 | 3065.6 | 0.0% |
| paged | 0 | mixed | 9.46 | 42.60 | 17.95 | 11.42 | 1873.3 | 0.0% |
| paged | 5 | cold | 69.93 | 138.52 | 44.35 | 18.12 | 3065.6 | 0.0% |
| paged | 5 | mixed | 45.83 | 93.16 | 27.97 | 11.42 | 1873.5 | 0.0% |
| paged | 20 | cold | 198.88 | 407.97 | 61.82 | 18.12 | 3065.6 | 0.0% |
| paged | 20 | mixed | 129.99 | 232.70 | 39.74 | 11.42 | 1873.9 | 0.0% |

## Bundle, storage and process memory

| Design | Bundle MiB | R2 MiB | Startup ms (range) | Sampled max RSS MiB (range) |
|---|---:|---:|---|---|
| 32-mixed | 32.000 | 397.4 | 5.98–13.79 | 264.0–290.6 |
| 48-mixed | 48.000 | 381.4 | 7.58–9.06 | 287.9–316.6 |
| paged | 0.168 | 430.5 | 3.67–4.53 | 237.8–270.0 |

## By query type, +20 ms/read, cold cache

| Design | Type | P50 ms | P95 ms | Reads/query |
|---|---|---:|---:|---:|
| 32-mixed | boolean | 35.10 | 49.18 | 2.00 |
| 32-mixed | phrase | 71.84 | 149.44 | 6.95 |
| 32-mixed | plain | 27.34 | 43.35 | 1.82 |
| 32-mixed | proximity | 34.31 | 100.63 | 3.67 |
| 48-mixed | boolean | 31.88 | 48.18 | 1.45 |
| 48-mixed | phrase | 67.36 | 118.16 | 5.50 |
| 48-mixed | plain | 23.99 | 35.89 | 1.12 |
| 48-mixed | proximity | 30.82 | 97.49 | 2.92 |
| paged | boolean | 354.87 | 424.00 | 19.90 |
| paged | phrase | 163.43 | 245.90 | 18.32 |
| paged | plain | 322.14 | 407.97 | 18.82 |
| paged | proximity | 145.41 | 225.64 | 15.45 |

## Actual local Worker verification

42 HTTP responses ran through the packaged Worker and Miniflare/workerd R2 binding, including plain, Boolean, phrase, proximity, missing terms, and Unicode queries. IDs and ordering matched the exhaustive reference, with a 1e-12 score tolerance across JS runtimes. Worker timings are local only; no artificial latency is injected in this check.

## Interpretation and limits

The actual 100k paged root passed Wrangler packaging: 279.97 KiB total uncompressed Worker upload (76.82 KiB gzip for reference). The root alone is 176,550 bytes. This dry run proves packaging compatibility, not deployed startup or isolate memory behavior.

The small bundle demonstrates that the complete dictionary and document tables no longer need to fit in a Worker. It does not establish that 10 million real documents meet latency or memory targets. Cold paging introduces additional read phases, particularly dictionary and external-ID resolution, and can increase latency despite transferring fewer posting bytes. The existing bundled design is favored when its dictionary and hot postings fit.

The paged block executor uses verified directories, 64 KiB frequency read-ahead, existing WAND bounds, and lazy document-length pages with four-page read-ahead. Phrase, proximity, negation, metadata, and exact-total queries retain the materialized executor with selective posting ranges. Materialized working-set checks and the 16 MiB query-local norm-page guard may reject very broad searches on much larger corpora. A forward index, result cache, continuation pagination, compressed dictionary pages, adaptive read-ahead, and retained search state are not implemented by this change.

Object counts and bytes are in each manifest. Estimated Class B operations per million queries are mean reads/query × 1,000,000; result/length/dictionary I/O is included. Converting that to dollars requires the applicable current R2 plan. Local process RSS includes Node/tsx and is not evidence of Worker isolate memory compliance.

## Reproduce

```sh
node --import tsx src/cli/main.ts page --source bench/generated/flp-100000/48-mixed --out bench/generated/flp-100000/paged
node --import tsx bench/paged.ts
node --import tsx bench/paged-worker.ts
python3 bench/paged-report.py
```

The corpus and frozen queries are the same as [FLP-100K.md](FLP-100K.md). Repacking is not a new corpus-ingestion throughput measurement. Choose a fresh output directory when reproducing the immutable generation.
