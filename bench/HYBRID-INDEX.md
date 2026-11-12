# Making the paged index competitive on 100k Free Law Project decisions

The 1.82 MiB hybrid improves cold P50/P95 from 189/386 ms to 56/140 ms under the +20 ms/read model: about 70%/64% lower latency than the original paged layout. Reads fall from 18.12 to 6.86/query, and bytes from 3,065.6 to 1,414.3 KiB/query. The 48 MiB bundled baseline remains faster at 28/105 ms. With no simulated delay, the hybrid and bundled baseline both measure about 7/36–37 ms.

The shared-bandwidth sensitivity run (+20 ms/read, 50 MiB/s) measures cold hybrid P50/P95 at 65/273 ms versus 32/251 ms for the 48 MiB baseline. The hybrid narrows the gap substantially but does not beat the larger bundled index.

## Implementation sequence

1. Bundle exact u32 body/title lengths and independently front-coded IDs, retaining R2 dictionary/postings/positions/metadata. Share validated immutable routing data across query views. Benchmark this with the previous fixed posting-read policy.
2. Add adaptive frequency reads: whole lists up to 256 KiB, directory plus initial 64 KiB for larger lists, and sequential read-ahead doubling up to 1 MiB. Reset read-ahead after a jump. Rebenchmark the fixed-policy ablation alongside the adaptive policy and both existing baselines.

The hybrid bundle is 1,910,250 bytes (1.82 MiB): 800,000 bytes of exact lengths, 933,694 bytes of compact IDs, and the routing root/header. It fits all 8/16/32/48 MiB budgets with identical contents; it is measured once rather than relabeled four times. There are no bundled term descriptors or postings. The 48 MiB bundled baseline retains its existing mixed embedding policy. The original fully paged baseline is its v1 root with fixed reads.

## First change measured before adaptive reads

| Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query |
|---:|---|---:|---:|---:|---:|
| 0 | cold | 6.91 | 37.02 | 8.24 | 1414.5 |
| 0 | mixed | 5.97 | 35.60 | 7.69 | 1396.0 |
| 5 | cold | 30.47 | 67.54 | 8.24 | 1414.5 |
| 5 | mixed | 28.30 | 68.89 | 7.69 | 1396.0 |
| 20 | cold | 98.12 | 184.65 | 8.24 | 1414.5 |
| 20 | mixed | 90.78 | 174.68 | 7.69 | 1396.0 |

## Final paired comparison: fixed delay, no bandwidth cap

| Design | Added ms/read | Cache | P50 ms | P95 ms | CPU ms/query | Reads/query | KiB/query | Zero reads |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 48-mixed | 0 | cold | 7.10 | 36.26 | 16.88 | 2.75 | 1204.1 | 13.8% |
| 48-mixed | 0 | mixed | 6.22 | 35.86 | 12.09 | 2.74 | 1204.0 | 13.8% |
| 48-mixed | 5 | cold | 12.60 | 45.43 | 17.63 | 2.75 | 1204.1 | 13.8% |
| 48-mixed | 5 | mixed | 12.42 | 48.48 | 15.53 | 2.74 | 1204.0 | 13.8% |
| 48-mixed | 20 | cold | 28.22 | 105.40 | 22.81 | 2.75 | 1204.1 | 13.8% |
| 48-mixed | 20 | mixed | 28.18 | 102.39 | 17.85 | 2.74 | 1204.0 | 13.8% |
| paged | 0 | cold | 18.77 | 55.08 | 32.39 | 18.12 | 3065.6 | 0.0% |
| paged | 0 | mixed | 9.41 | 44.90 | 18.26 | 11.41 | 1873.7 | 0.0% |
| paged | 5 | cold | 61.49 | 115.04 | 33.14 | 18.12 | 3065.6 | 0.0% |
| paged | 5 | mixed | 40.23 | 88.05 | 26.45 | 11.42 | 1873.3 | 0.0% |
| paged | 20 | cold | 188.96 | 386.39 | 65.38 | 18.12 | 3065.6 | 0.0% |
| paged | 20 | mixed | 123.71 | 224.97 | 39.19 | 11.42 | 1873.3 | 0.0% |
| hybrid-tables | 0 | cold | 7.14 | 36.03 | 17.16 | 8.24 | 1414.5 | 0.0% |
| hybrid-tables | 0 | mixed | 6.22 | 37.37 | 12.83 | 7.69 | 1396.0 | 0.0% |
| hybrid-tables | 5 | cold | 30.38 | 68.75 | 22.46 | 8.24 | 1414.5 | 0.0% |
| hybrid-tables | 5 | mixed | 28.84 | 68.32 | 19.98 | 7.69 | 1396.0 | 0.0% |
| hybrid-tables | 20 | cold | 97.87 | 175.01 | 35.14 | 8.24 | 1414.5 | 0.0% |
| hybrid-tables | 20 | mixed | 91.35 | 173.65 | 28.35 | 7.69 | 1396.0 | 0.0% |
| hybrid-adaptive | 0 | cold | 7.15 | 36.77 | 17.16 | 6.86 | 1414.3 | 0.0% |
| hybrid-adaptive | 0 | mixed | 6.53 | 34.65 | 12.68 | 6.58 | 1395.9 | 0.0% |
| hybrid-adaptive | 5 | cold | 22.70 | 58.18 | 21.22 | 6.86 | 1414.3 | 0.0% |
| hybrid-adaptive | 5 | mixed | 19.80 | 57.90 | 18.48 | 6.58 | 1395.9 | 0.0% |
| hybrid-adaptive | 20 | cold | 55.99 | 139.86 | 25.46 | 6.86 | 1414.3 | 0.0% |
| hybrid-adaptive | 20 | mixed | 52.78 | 140.63 | 21.56 | 6.57 | 1391.0 | 0.0% |

## Bandwidth sensitivity: +20 ms/read, shared 50 MiB/s transfer budget

| Design | Cache | P50 ms | P95 ms | Reads/query | KiB/query |
|---|---|---:|---:|---:|---:|
| 48-mixed | cold | 31.72 | 250.82 | 2.75 | 1204.1 |
| 48-mixed | mixed | 29.90 | 236.29 | 2.74 | 1204.0 |
| hybrid-tables | cold | 110.60 | 295.20 | 8.24 | 1414.5 |
| hybrid-tables | mixed | 100.71 | 281.20 | 7.69 | 1396.0 |
| hybrid-adaptive | cold | 65.00 | 273.31 | 6.86 | 1414.3 |
| hybrid-adaptive | mixed | 59.60 | 276.51 | 6.58 | 1395.9 |

## Cold I/O breakdown, +20 ms/read without bandwidth cap

| Design | Dictionary reads | Length reads | Result-record reads | Frequency reads | Position reads |
|---|---:|---:|---:|---:|---:|
| 48-mixed | 0.00 | 0.00 | 0.00 | 1.56 | 1.19 |
| paged | 2.55 | 4.99 | 4.89 | 4.29 | 1.39 |
| hybrid-tables | 2.55 | 0.00 | 0.00 | 4.29 | 1.39 |
| hybrid-adaptive | 2.55 | 0.00 | 0.00 | 2.92 | 1.39 |

## Query types, cold +20 ms/read

| Design | Type | P50 ms | P95 ms | Reads/query |
|---|---|---:|---:|---:|
| 48-mixed | plain | 23.65 | 35.50 | 1.12 |
| 48-mixed | boolean | 32.19 | 47.78 | 1.45 |
| 48-mixed | phrase | 64.34 | 116.52 | 5.50 |
| 48-mixed | proximity | 29.62 | 94.45 | 2.92 |
| paged | plain | 310.11 | 386.39 | 18.82 |
| paged | boolean | 345.64 | 418.51 | 19.90 |
| paged | phrase | 154.50 | 242.24 | 18.32 |
| paged | proximity | 134.38 | 210.63 | 15.45 |
| hybrid-tables | plain | 98.78 | 183.56 | 6.85 |
| hybrid-tables | boolean | 136.47 | 201.65 | 8.78 |
| hybrid-tables | phrase | 108.79 | 168.03 | 11.10 |
| hybrid-tables | proximity | 60.36 | 131.08 | 6.22 |
| hybrid-adaptive | plain | 48.72 | 61.26 | 4.05 |
| hybrid-adaptive | boolean | 59.84 | 93.01 | 6.08 |
| hybrid-adaptive | phrase | 106.60 | 162.52 | 11.10 |
| hybrid-adaptive | proximity | 58.16 | 121.94 | 6.22 |

## Bundle, storage, startup and memory

| Design | Bundle MiB | R2 MiB | Startup ms (range) | Sampled max RSS MiB (range) |
|---|---:|---:|---|---|
| 48-mixed | 48.000 | 381.4 | 8.35–12.33 | 262.2–315.5 |
| paged | 0.168 | 430.5 | 4.19–4.64 | 230.8–244.5 |
| hybrid-tables | 1.822 | 430.5 | 29.06–31.43 | 225.2–258.4 |

## Validation and interpretation

8,640 timed searches matched the frozen exhaustive-reference results exactly. 42 additional real local Worker HTTP responses matched IDs/order and scores within 1e-12 across runtimes. Wrangler packaging of the actual hybrid root: 1977.58 KiB / gzip: 776.11 KiB. No deployment to Cloudflare was performed.

The first optimization removes all remote length and result-record reads for ID-only searches. The adaptive policy reduces dependent posting reads by spending more bytes where needed. The full dictionary still lives in R2, so cold queries retain a dictionary-read phase. The hybrid uses far less bundle space than the 48 MiB baseline; it does not embed that baseline’s hot posting streams. Any remaining latency and bytes gap must be evaluated in that context.

## Method and limits

The same 100,000 decisions, tokenization, document order, scoring statistics and codecs are used throughout. The frozen 160-query evaluation workload has 40 queries each of plain, Boolean, phrase and proximity types. The corpus and workload provenance remain in [FLP-100K.md](FLP-100K.md). Queries return the best 20 external IDs/scores, with exact totals off and metadata off. Metadata queries still fetch result records and metadata separately; tests compare those against the original engine.

Cold clears the 4 MiB engine cache before each query. Mixed runs two sequential workload passes with a shared 4 MiB cache and includes the initially cold pass. Every design/delay combination uses a separate process. Reference results are computed before timing and loaded as a small file in child processes. Correctness checks and RSS sampling happen after query timing. Local OS file caches may be warm. CPU is process CPU consumed during a query. RSS is sampled Node/tsx process memory, not Worker isolate memory; startup includes local file reading and index construction, not deployed startup CPU. Local timing noise remains; raw samples are retained.

The fixed-delay model adds 0/5/20 ms to every actual read while allowing concurrent requests to overlap. The optional bandwidth model additionally reserves transfer time on a FIFO 50 MiB/s link shared by all reads within a query, after their added latency. It is not a cap per connection. It does not model jitter, geography, R2 server queues, HTTP multiplexing details or concurrent user queries. These are sensitivity measurements, not predictions of deployed R2 latency.

The first-step measurements were taken before implementing adaptive reads. The final matrix reruns the fixed-policy ablation beside the adaptive policy. Reuse of immutable routing data was introduced with the local tables, so the first-step CPU improvement includes avoiding repeated routing JSON parsing.

Local tables scale with document count: exact norms use 8 bytes/document and IDs have corpus-dependent compression. A configured bundle budget is enforced; these tables are optional. The fully paged fallback remains available for larger corpora. These measurements do not prove ten-million-document latency or memory safety. Materialized executor working-set guards and the 16 MiB remote-norm guard remain.

The next major opportunities are workload-selected dictionary/posting embedding and selective position fetching for connector candidates. No forward index, persistent pagination cursor, result cache, quantized scoring or workload-selected phrase accelerator was added.

## Reproduce

```sh
node --import tsx src/cli/main.ts page --source bench/generated/flp-100000/48-mixed --out bench/generated/flp-100000/hybrid-tables --local-tables --budget-mib 8
PAGED_DESIGNS=hybrid-tables PAGED_PREFIX=hybrid-step1 node --import tsx bench/paged.ts
PAGED_DESIGNS=48-mixed,paged,hybrid-tables,hybrid-adaptive PAGED_PREFIX=hybrid-final node --import tsx bench/paged.ts
PAGED_DESIGNS=48-mixed,hybrid-tables,hybrid-adaptive PAGED_PREFIX=hybrid-final PAGED_DELAYS=20 PAGED_BANDWIDTH_MIB=50 node --import tsx bench/paged.ts
PAGED_DESIGNS=48-mixed,paged,hybrid-adaptive PAGED_PREFIX=hybrid-final node --import tsx bench/paged-worker.ts
python3 bench/hybrid-report.py
```

`hybrid-adaptive` is a benchmark alias for the same `hybrid-tables` bundle with adaptive reads; the fixed ablation explicitly selects the old policy. A newly built v2 hybrid Worker defaults to adaptive reads. Preserve immutable outputs and choose a fresh directory when rebuilding.
