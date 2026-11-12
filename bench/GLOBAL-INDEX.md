# Global retrieval engine: 100k Free Law Project experiment

Measured November 12, 2026. This is a functioning separate Worker/R2 engine,
not a migration of the growing full-corpus demo. Its main benefit is eliminating
partition/statistics fanout and addressing display records/passages directly.
The outcome is mixed: ordinary and repeated queries improve, but broad phrases
remain substantially slower than the existing engine. The 200–400 ms goal is not
consistently met for unfamiliar searches.

## Corpus, builds and correctness

The same 100,000-opinion FLP corpus as [the earlier benchmark](FLP-100K.md):
632,909 terms, 187,425,411 body tokens, mean body length 1,874 tokens, median 855,
P95 6,983, maximum 171,442. This is a clustered sample, not a random or
representative sample of all legal research. The legal scenario suite has 16
queries; a disjoint 16-query stress holdout comes from the earlier corpus-derived
evaluation set. Neither is a production traffic distribution.

Conversion reused the existing sorted source and took 18.74 minutes;
adding tight bounds took 4.60 minutes. This excludes the original source
build, uploads and display-head conversion. 104 immutable objects total
6,875,840,512 bytes (6.88 GB), including retained coarse-layout
dictionary objects. The append-only upgrade adds roughly 0.56 GB; a fresh compact
generation could remove unused coarse dictionaries.

| Budget MiB | Base bundle bytes | Complete-head bundle bytes | Local terms in heads |
| ---------: | ----------------: | -------------------------: | -------------------: |
|          8 |           8050064 |                    7927644 |                14634 |
|         16 |          15919212 |                   15609759 |                36381 |
|         32 |          31625266 |                   30929306 |                79614 |
|         48 |          47299441 |                   46197114 |               122226 |

All queries are checked against the materialized existing source engine: IDs,
score tolerance 1e-11 relative, and display fields. Tests additionally compare
fields, boosts, negative/grouped Boolean expressions, phrases, repeated terms,
proximity and search-after. All **168 tests in 32 files** pass, including actual
workerd/Miniflare R2 and Cache API integration. TypeScript checking passes.
Wrangler local development and the generic signed-in upload/deploy command were
also exercised end to end.

## Sequential optimization rounds

These controlled local runs use the same 8-MiB index, 64-KiB read pages, fresh
isolate-memory simulation and fixed 20-ms whole-read waits, with six slots. They
are not native Cloudflare latency measurements. Each round executes all 16 legal
scenarios. Host CPU/load can vary between rounds; one pass is not a confidence
interval.

| Variant              |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 | Mean Node CPU ms |
| -------------------- | --: | -----: | -----: | ------------: | ------: | ---------------: |
| 0-coarse-four        |  16 |    373 |   1557 |          63.1 |    0.0% |            161.3 |
| 1-tight-bulk         |  16 |    285 |    892 |          56.7 |    0.0% |            104.8 |
| 2-direct-decode      |  16 |    270 |    882 |          56.7 |    0.0% |            100.7 |
| 3-result-prefetch    |  16 |    284 |    886 |          61.5 |    0.0% |             89.3 |
| 4-complete-heads     |  16 |    268 |    857 |          55.1 |    6.3% |             72.2 |
| 5-heap-admission     |  16 |    268 |    853 |          55.1 |    6.3% |             77.2 |
| 6-decoded-read-reuse |  16 |    268 |    868 |          55.1 |    6.3% |             71.0 |

Round 1 tightens bounds from 512 to 64 documents and expands scheduling from four
to 32 cells, under byte caps. Round 2 reuses decoded blocks and removes positional
re-encoding: average Node CPU improves, while median elapsed time fluctuates.
Round 3's speculative result prefetch increases reads/tail latency and stays off.
Round 4 adds complete display heads selected by corpus DF, recovering bundle
space by omitting unrelated seeds. A complete top-20 `court` response requires
zero storage reads, not just zero index reads. No query-response cache or
workload-selected phrase accelerators are used.

The header-aware pipeline was tested separately with identical per-page sampled
latencies, 128-KiB pages, no shared cache and fresh memory:

| Variant |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 | Mean Node CPU ms |
| ------- | --: | -----: | -----: | ------------: | ------: | ---------------: |
| false   |  16 |   1997 |   4515 |          43.3 |    0.0% |            159.4 |
| true    |  16 |   1832 |   3500 |          42.6 |    0.0% |            152.8 |

The connection limit applies to requests waiting for headers, so six header waits
can overlap more body transfers. Batches still cap physical pages at 16 MiB.
This experiment isolates pipeline behavior and should not be compared directly
with the preceding fixed-delay rows.

Round 5 avoids result/passage pointer preparation for candidates already below
the exact heap threshold. Heap entries also release positional arrays after
retaining the selected passage pointers; rare-lead eager reads obey the same
raw-byte limit as ordinary batches. Round 6 bypasses storage/decompression for
already decoded blocks and retains bounded per-batch decoded rows. In this
scenario suite it reduces mean Node CPU modestly but does not produce a clear
latency or origin-read improvement. It does not fix the broad phrase tail.

## Four-budget local matrix

The model uses the serial varied-range subset (144 observations) of the earlier
864 measured R2 header/body timings,
uses six header slots and an assumed 1-ms shared-cache get/put. Each configuration
receives eight disjoint warmup queries, then 16 unfamiliar queries. Metadata and
query-relevant passages are included. Shared pages and memory persist across a
configuration; response caching is absent. The legacy engine runs its real
gateway/card/excerpt pipeline with one service-bound leaf on this same corpus.
Its local trace includes leaf I/O. Page-size rows are independent configurations.
The baseline's card packs have no optional passage sidecar, so excerpts use its
full-body fallback. This is the prior 100k paged-engine baseline, not a controlled
speedup estimate for the latest multi-million-document demo with passage backfill.
Baseline 8-MiB index, cards and body objects total 965,751,968 bytes, compared
with 6,875,840,512 bytes here (about 7.1 times as much storage).
This matrix predates final heap admission and adaptive cache accounting; those
changes have separate controlled/native rounds below.

| Variant             |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 |
| ------------------- | --: | -----: | -----: | ------------: | ------: |
| old/8/-/novel       |  16 |   1216 |   2623 |          34.8 |    0.0% |
| global/8/64/novel   |  16 |   1837 |   3894 |          45.4 |    6.3% |
| global/8/128/novel  |  16 |   2087 |   3941 |          33.2 |    6.3% |
| global/8/256/novel  |  16 |   1042 |   2075 |          26.9 |    6.3% |
| old/16/-/novel      |  16 |   1180 |   2682 |          34.7 |    0.0% |
| global/16/64/novel  |  16 |   1827 |   3964 |          45.4 |    6.3% |
| global/16/128/novel |  16 |   2037 |   3861 |          33.2 |    6.3% |
| global/16/256/novel |  16 |   1005 |   2019 |          26.9 |    6.3% |
| old/32/-/novel      |  16 |   1235 |   2377 |          34.7 |    0.0% |
| global/32/64/novel  |  16 |   1826 |   4027 |          45.2 |    6.3% |
| global/32/128/novel |  16 |   2068 |   3674 |          33.0 |    6.3% |
| global/32/256/novel |  16 |    990 |   2071 |          26.7 |    6.3% |
| old/48/-/novel      |  16 |   1196 |   1855 |          34.6 |    0.0% |
| global/48/64/novel  |  16 |   1775 |   3964 |          44.9 |    6.3% |
| global/48/128/novel |  16 |   1888 |   3603 |          32.8 |    6.3% |
| global/48/256/novel |  16 |    941 |   1999 |          26.4 |    6.3% |
| heads/8/128/novel   |  16 |   2094 |   3935 |          32.0 |   12.5% |
| heads/16/128/novel  |  16 |   2078 |   3910 |          32.0 |   12.5% |
| heads/32/128/novel  |  16 |   2094 |   3666 |          31.9 |   12.5% |
| heads/48/128/novel  |  16 |   1907 |   3633 |          31.6 |   12.5% |
| heads/8/256/novel   |  16 |   1008 |   2047 |          25.8 |   12.5% |
| heads/16/256/novel  |  16 |   1002 |   2046 |          25.8 |   12.5% |
| heads/32/256/novel  |  16 |   1025 |   2077 |          25.7 |   12.5% |
| heads/48/256/novel  |  16 |    949 |   2040 |          25.4 |   12.5% |

256-KiB grouping generally wins this workload despite greater read amplification.
Additional bundle space does little here because the evaluated common-term plans
already fit at 8 MiB. This is not evidence that bundle size is irrelevant for
long-tail vocabularies. Node CPU/RSS include the reference index, local caches and
benchmark runtime; RSS is **not** Cloudflare isolate memory. Raw values and
cold/repeated-cache runs are in the machine-readable artifacts.

## Native Workers/R2 measurements

All variants were deployed to Cloudflare with the complete 100k generation.
The R2 bucket is in ENAM. The client is this local machine; client latency includes
its network connection. Variants are interleaved with cyclic/reversed order.
The first 16-query pass follows eight disjoint warmups; repeated rows pool two
further passes. P50 uses the midpoint median, P95 nearest rank; with N=16, P95 is
the maximum. These small scenario samples have substantial timing variance.

| Variant                                                        |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 |
| -------------------------------------------------------------- | --: | -----: | -----: | ------------: | ------: |
| unfamiliar-after-disjoint/work-search-global-old               |  16 |    931 |   2105 |          33.9 |     n/a |
| unfamiliar-after-disjoint/work-search-global                   |  16 |   1082 |   3123 |          40.8 |   12.5% |
| unfamiliar-after-disjoint/work-search-global-p128              |  16 |    867 |   1922 |          33.2 |    6.3% |
| unfamiliar-after-disjoint/work-search-global-p256              |  16 |    782 |   1831 |          26.9 |    6.3% |
| unfamiliar-after-disjoint/work-search-global-heads             |  16 |    847 |   2691 |          25.8 |   12.5% |
| unfamiliar-after-disjoint/work-search-global-smart             |  16 |    908 |   2397 |          25.8 |   12.5% |
| unfamiliar-after-disjoint/work-search-global-east              |  16 |   1709 |   3680 |          25.8 |   12.5% |
| repeated/work-search-global-old                                |  32 |    374 |   1037 |          21.9 |     n/a |
| repeated/work-search-global-east                               |  32 |    362 |   1434 |           0.0 |  100.0% |
| repeated/work-search-global-smart                              |  32 |    213 |    817 |           0.0 |  100.0% |
| repeated/work-search-global-heads                              |  32 |    145 |    567 |           0.0 |  100.0% |
| repeated/work-search-global-p256                               |  32 |    141 |    677 |           0.0 |  100.0% |
| repeated/work-search-global-p128                               |  32 |    157 |    476 |           0.0 |  100.0% |
| repeated/work-search-global                                    |  32 |    139 |    520 |           0.0 |  100.0% |
| unfamiliar-corpus-primed-empty-memory/work-search-global-old   |  16 |    910 |   1457 |          36.4 |     n/a |
| unfamiliar-corpus-primed-empty-memory/work-search-global-heads |  16 |   1305 |  25590 |         270.3 |    6.3% |

For the primary unfamiliar legal suite, base 256-KiB global retrieval is faster
than the existing engine; complete display heads trade a better median for a
worse tail in this pass. For repeated queries, new variants make zero R2 reads
and are much faster. They still parse, score and read/decompress cached pages;
there is no complete-response cache. Smart Placement and US-East placement do
not improve the full distribution here; region hints are not proof of exact
colocation with the bucket.

The corpus-primed holdout warms index pages using the top 64 terms by corpus DF,
ID-only limit 100, never future query strings or result records. Isolate memory
is cleared before each timed holdout query, outside timing. Broad unfamiliar
phrases expose a serious regression: thousands of positional reads and many
dependent batches. Do not summarize the repeated-query win as the unfamiliar
query performance. Native legacy request counts in this table cover the gateway
only (leaf I/O is opaque); new engine counts cover the full engine, so these
native request counts are **not directly comparable across engines**.

### Additional round: competitive positional verification (rejected default)

Two fresh Worker/cache namespaces receive identical corpus-only ID priming, then
interleaved legal/stress queries. Memory is cleared before every request. Pass 0
is unfamiliar; pass 1 repeats those query strings. Frequency-only candidates are
ranked first; only competitive candidates receive exact positional verification.
The heap stops only with an exact proof. This reduces decoding CPU in local
checks but increases positional read stages. It remains disabled by default.

| Variant                                 |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 |
| --------------------------------------- | --: | -----: | -----: | ------------: | ------: |
| 0/legal/work-search-global-control      |  16 |    604 |   1516 |          26.3 |    6.3% |
| 0/legal/work-search-global-competitive  |  16 |    610 |   1210 |          26.3 |    6.3% |
| 0/stress/work-search-global-control     |  16 |    979 |  25504 |         271.9 |    6.3% |
| 0/stress/work-search-global-competitive |  16 |    928 |  29631 |         445.6 |    6.3% |
| 1/legal/work-search-global-competitive  |  16 |    134 |    514 |           0.0 |  100.0% |
| 1/legal/work-search-global-control      |  16 |    153 |    592 |           0.0 |  100.0% |
| 1/stress/work-search-global-competitive |  16 |    404 |  30256 |         421.4 |   81.3% |
| 1/stress/work-search-global-control     |  16 |    451 |  27375 |         248.6 |   81.3% |

A 256-candidate verification-batch variant was also checked locally; the raw-byte
cap still constrains broad phrases, so it does not remove the extra reads. The
full empirical-latency paired run and CPU-only controls are archived.

### Additional round: adaptive shared-cache call budget

The fixed control checks at most 384 pages, reserving a put for every lookup.
The adaptive version counts actual operations and allows at most 960 total
get/put calls. Cached hits can use the remaining allowance; misses are still
limited safely below Cloudflare's 1,000 Cache API calls. No bundle bytes are added.
Fresh Workers, corpus-only priming, interleaved queries and memory resets match
the previous protocol.

| Variant                                  |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 |
| ---------------------------------------- | --: | -----: | -----: | ------------: | ------: |
| 0/legal/work-search-global-cachecontrol  |  16 |    586 |   1498 |          26.3 |    6.3% |
| 0/legal/work-search-global-adaptive      |  16 |    760 |   1492 |          26.3 |    6.3% |
| 0/stress/work-search-global-cachecontrol |  16 |    942 |  27379 |         271.5 |    6.3% |
| 0/stress/work-search-global-adaptive     |  16 |   1137 |  23192 |         167.9 |    6.3% |
| 1/legal/work-search-global-adaptive      |  16 |    204 |    915 |           0.0 |  100.0% |
| 1/legal/work-search-global-cachecontrol  |  16 |    160 |    631 |           0.0 |  100.0% |
| 1/stress/work-search-global-adaptive     |  16 |    489 |  22336 |         140.3 |   81.3% |
| 1/stress/work-search-global-cachecontrol |  16 |    421 |  23403 |         248.2 |   81.3% |

This cuts origin reads/tail latency on the broad stress suite, but is not a median
latency win across the legal suite. It is the default page-cache policy for the
new engine; `PAGE_CACHE_POLICY=fixed384` retains the control. A shared page hit
still incurs Cache API latency and decompression/verification work. Origin reads
and transferred bytes must be assessed separately from complete response time.

### Final verification runs

The final heap-admission comparison uses the prior 100k baseline and a fresh
complete-heads/adaptive global Worker. Corpus term priming and per-query memory
resets are identical. The legacy backend had prior benchmark exposure; native
backend cache state cannot be forcibly reset. Pass 0 is the first query-string
pass for the new Worker; pass 1 repeats queries. This is a different protocol
from the earlier disjoint-warmup comparison and does not establish a general
median improvement for unfamiliar queries. Legacy R2 counts still omit leaf I/O.

| Variant                           |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 |
| --------------------------------- | --: | -----: | -----: | ------------: | ------: |
| 0/legal/work-search-global-old    |  16 |    572 |    838 |          36.1 |     n/a |
| 0/legal/work-search-global-final  |  16 |    685 |   1384 |          26.3 |    6.3% |
| 0/stress/work-search-global-old   |  16 |    849 |   1289 |          36.3 |     n/a |
| 0/stress/work-search-global-final |  16 |    848 |  20839 |         168.5 |    6.3% |
| 1/legal/work-search-global-final  |  16 |    132 |    605 |           0.0 |  100.0% |
| 1/legal/work-search-global-old    |  16 |    700 |   1055 |          36.1 |     n/a |
| 1/stress/work-search-global-final |  16 |    360 |  23474 |         139.9 |   81.3% |
| 1/stress/work-search-global-old   |  16 |    728 |   1273 |          36.3 |     n/a |

After the decoded-fetch reuse fix, all four bundle budgets were rerun locally
with the final complete-heads/256-KiB/adaptive configuration:

| Variant |   N | P50 ms | P95 ms | Mean R2 reads | Zero R2 | Mean Node CPU ms |
| ------- | --: | -----: | -----: | ------------: | ------: | ---------------: |
| 8/256   |  16 |   1018 |   2017 |          25.8 |   12.5% |            104.8 |
| 16/256  |  16 |   1006 |   2085 |          25.8 |   12.5% |            108.4 |
| 32/256  |  16 |   1000 |   2030 |          25.7 |   12.5% |             86.3 |
| 48/256  |  16 |    937 |   2050 |          25.4 |   12.5% |             69.0 |

A final correctness review removed seed-based priority among equal-bound windows:
those windows must sort by minimum document ID for tie stopping to be valid.
A 6,000-document regression test with late seeds, zero title boost, one-cell
batches and search-after failed before the fix and now passes. The final local
matrix above includes this correction.

The final native API was also checked against the reference for four cold-memory
queries, including a broad phrase. The published public API also returned two correct
20-result pages with zero title boost against the source oracle. Those probes
are archived separately and are not latency percentiles. Initial retrieval probes are archived as
`native-reuse-smoke.json.gz`, not treated as percentiles. The original native
matrix predates heap admission/decoded-fetch reuse; later rounds and final local
matrix distinguish these versions rather than relabeling old timings as final.

## CPU, startup, memory and operating cost

Wrangler reported native startup for the 48-MiB-budget complete-head Worker at
606 ms, with 45,187.75 KiB uncompressed upload and 29,135.64 KiB gzip. Its root
contains 46,197,114 bytes and stays within budget. Native 48-MiB smoke requests
for `court`, `summary judgment` and a four-term phrase returned correct-length
responses without memory errors; this is not a full native four-budget matrix.
The local matrix covers all four budgets. Cloudflare currently documents a
64-MiB uncompressed bundle limit, 128-MB isolate memory and one-second startup
limit; the 48-MiB option leaves code/startup/memory headroom but is not a
concurrent-load guarantee. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

A separate native tail probe on the 8-MiB complete-head demo reports:

| Query                           | Native CPU ms | Native wall ms |
| ------------------------------- | ------------: | -------------: |
| court                           |             9 |             14 |
| summary judgment                |            71 |            111 |
| "clear and convincing evidence" |           498 |           1778 |
| court                           |             4 |              4 |

These are four probes with uncontrolled cache state, not latency percentiles.
In particular, phrase CPU is material even with fewer storage waits. Peak native
isolate memory and concurrent-load behavior were not measured. The engine caps
plan bytes, batch bytes, decoded caches, positional scratch and requests; this
does not establish a safe concurrency level for every bundle/query combination.

At published R2 Standard prices, the 6.88-GB generation is roughly
$0.103/month in marginal storage before free allowances/rounding.
For a million searches, R2 Class B cost is approximately
`0.36 * mean R2 GETs per search` dollars before allowances. For example,
25.8 GETs/search is about $9.29/million searches; zero origin reads eliminate
that component. R2 egress is free. These estimates exclude Workers requests/CPU,
baseline subscription, upload operations, other stored generations and any
custom-domain plan costs. [Official R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Reproduce and inspect

```sh
# Corpus/source preparation is documented in FLP-100K.md.
npm run global:build -- --input bench/generated/flp-100000/corpus.jsonl \
  --source bench/generated/flp-100000/source --out work/global-100k \
  --budgets 8,16,32,48 --page-kib 64
node --import tsx bench/global-prepare-baseline.ts
node --import tsx bench/global-rounds.ts
node --import tsx bench/global-pipeline.ts
node --import tsx bench/global-matrix.ts
GLOBAL_HEADS=1 GLOBAL_BENCH_ONLY=global GLOBAL_BENCH_PAGES=256 \
  GLOBAL_BENCH_LABEL=matrix-heads256 node --import tsx bench/global-local.ts
node --import tsx bench/global-competitive.ts
# Signed-in demo account and private ignored configuration are required below.
node --import tsx scripts/deploy-global-baseline.ts
node --import tsx scripts/deploy-global.ts work/global-100k
node --import tsx bench/global-deploy-variants.ts
node --import tsx bench/global-native.ts
node --import tsx bench/global-native-competitive.ts
GLOBAL_NATIVE_VARIANTS=work-search-global-cachecontrol,work-search-global-adaptive \
  GLOBAL_NATIVE_LABEL=native-adaptive node --import tsx bench/global-native-competitive.ts
GLOBAL_NATIVE_VARIANTS=work-search-global-old,work-search-global-final \
  GLOBAL_NATIVE_LABEL=native-final node --import tsx bench/global-native-competitive.ts
GLOBAL_NO_LATENCY=1 GLOBAL_COMPETITIVE_LABEL=decoded-reuse \
  node --import tsx bench/global-competitive.ts
GLOBAL_HEADS=1 GLOBAL_BENCH_ONLY=global GLOBAL_BENCH_PAGES=256 \
  GLOBAL_CACHE_POLICY=adaptive960 GLOBAL_BENCH_LABEL=matrix-final \
  node --import tsx bench/global-local.ts
node --import tsx bench/global-smoke.ts
node --import tsx bench/global-native-cpu.ts
node --import tsx bench/global-report.ts
```

Local latency runs require `work/demo-bench/latency.json` from the earlier
[recorded demo benchmark](DEMO-REALISTIC.md). The raw measured calibration
source is archived here as `results/global-v1/calibration.json.gz`; never substitute a
fixed delay while claiming an empirical/native result. Native cache-priming
experiments require fresh Worker/cache namespaces for a genuinely unfamiliar
first pass. Deployment helpers accept environment overrides; provision the two
control/experimental Workers with the appropriate `GLOBAL_COMPETITIVE` and
`GLOBAL_CACHE_POLICY` settings before their comparison.

[Machine summary](results/global-v1/summary.json) and the adjacent gzip-compressed
JSON files contain every recorded row, diagnostics and methodology labels. They
are actual measurements, not projected speedups. Do not compare local modeled
latency directly to native latency or pool different cache states.

## Remaining work before full-corpus adoption

1. Smaller independently addressed positional groups: the broad phrase tail is
   dominated by loading/decoding positions for many irrelevant documents. The
   competitive query scheduler alone did not fix that format problem.
2. Merge source generations directly into a global index without requiring one
   legacy bundled source. The current converter is validated at 100k, not 7M/10M.
3. Hierarchical block-plan pages for very frequent terms, native memory/load
   profiling, concurrency admission and a substantially larger held-out workload.
4. A real custom-domain/Tiered Cache experiment. The CDN adapter and immutable-page
   exporter exist, but only Cache API + R2 bindings were deployed/tested.
5. Compact obsolete append-only layout objects into a fresh generation after
   deciding which layouts to retain. Preserve rollback-root object references.

The deployed experimental [100k API](https://work-search-global-demo.phulin.workers.dev/search?q=summary+judgment)
uses an 8-MiB budget, complete display heads, 256-KiB reads and adaptive page cache.
The full-corpus Casework demo remains on its existing engine.
