# Exact phrase retrieval experiments — 100k FLP

These experiments target the global engine's broad-phrase regression. They keep
original unigram BM25, exact phrase/proximity semantics, stable ties and pagination.
The full-corpus demo/import are unchanged. All index-data budgets remain
8/16/32/48 MiB; auxiliary binary roots count against the same budget.

## Protocol

The corpus, base generation, 16 legal queries and 16 stress queries are the same
as [the global-engine comparison](GLOBAL-INDEX.md). Every measured response is
checked against the materialized source engine for exact IDs and scores. Native
runs also compare titles and metadata. Results include display records and
query-relevant excerpts; there is no response cache and no candidate truncation.

Local matrix: cold 8-MiB page cache per query, no shared cache, 256-KiB base read
groups and 64-KiB pair pages. Per-page header/body delays use the archived measured
R2 distribution and deterministic address-based seeds. This is a local simulation,
not a deployed-Worker latency claim. CPU-only controls disable delays. Node process
RSS includes the legacy oracle index, benchmark harness, caches and retained V8
heap; it is **not Worker isolate memory**. CPU microseconds come from process.cpuUsage,
not Worker wall-clock diagnostics. The `verifiedDocuments` diagnostic counts the
second-phase verifier only; fused first-batch checks still run when that counter
is zero. Native Worker peak memory and CPU were not measured.

Native protocol: dedicated Worker/cache namespaces, corpus-DF top-64 term prime
(IDs only), then interleaved full top-20 queries, followed by the same queries
again. Isolate memory is cleared for every measured request. The first pass uses
unfamiliar multi-term queries over partially warmed index pages; the second pass
has previously requested pages. Latency is measured at the external HTTP client,
including the full response body. All native responses in these comparisons came from BOS. P95 over 16 queries is the worst query, **not a population percentile**.
Cold, first-pass and repeated-page results are deliberately reported separately.

## Sequential experiments

1. Adaptive verification initially probes 32 score-ordered cells using frequency
   candidates, then switches sparse queries to bounded document-order positional
   verification. Dense queries retain score order. Batches remain subject to
   raw-byte and physical-page limits; document-order execution cannot globally
   stop at an uncompetitive cell.
2. Corpus-selected adjacent pairs produce conservative document candidate sets.
   Independent phrase lookups are batched, then selected postings are batched.
   The base engine prunes impossible cells and still verifies full positions.
   A 32-MiB R2 allowance selected too few useful pairs; a 128-MiB allowance improves
   coverage without increasing the bundled-data budget. See [build/coverage details](PAIR-INDEX.md).
3. Optional intersection of multiple affordable pair lists tightens long-phrase
   candidates in the same postings stage, under the same aggregate 32,768-entry
   cap. It never turns pair occurrence into a proof of full phrase alignment.
4. Revised adaptive probing uses the original fused frequency-plus-position path
   for the first batch. Dense queries keep that original path. Sparse queries
   clear the decoded cache before switching to buffered frequency-first scans.
   This addresses cold-cache read regressions seen with the first probe.
5. A compact rare-pair variant reserves all observed pairs with corpus DF ≤16
   inside remote dictionary entries, then selects larger pairs by the same corpus
   utility. Binary descriptors and larger bounded dictionary pages reduce per-pair
   overhead. This changes corpus coverage, not query-dependent caching.

All pair and primary readers share one 8-MiB cache and request budget. The 960
Cache API operation cap and 8,000 origin request cap apply to the whole query,
including pair discovery. Unknown/oversized pair filters safely fall back.

## First adaptive implementation: native results

Two fresh namespaces, 8-MiB data budget; same protocol and oracle:

| Workload/pass          | Before P50 / P95 | Adaptive P50 / P95 | Average R2 GETs before → after |
| ---------------------- | ---------------: | -----------------: | -----------------------------: |
| Legal, unfamiliar      |    890 / 1889 ms |      721 / 1852 ms |                  26.31 → 26.31 |
| Stress, unfamiliar     |  1035 / 34578 ms |      846 / 5937 ms |                 168.38 → 25.56 |
| Legal, repeated pages  |     138 / 690 ms |       134 / 494 ms |                          0 → 0 |
| Stress, repeated pages |   616 / 24437 ms |      527 / 3997 ms |                     140.50 → 0 |

These are controls for the initial competitive probe, not the final tuned selector.
The cold local run exposes a legal-set P95 regression (2.85 → 3.77 seconds) from
extra frequency/position read stages, which motivated fused probing. Do not infer
that every query improves from the aggregate sparse-phrase win.

## Adding the 128-MiB-allowance pair sidecar

Separate fresh adaptive-only and pair-enabled namespaces, 8-MiB data budget:

| Workload/pass          | Adaptive P50 / P95 | With pairs P50 / P95 |
| ---------------------- | -----------------: | -------------------: |
| Legal, unfamiliar      |      607 / 1216 ms |        654 / 1690 ms |
| Stress, unfamiliar     |      929 / 3656 ms |        946 / 2634 ms |
| Legal, repeated pages  |       144 / 445 ms |         154 / 768 ms |
| Stress, repeated pages |      502 / 2863 ms |        392 / 2077 ms |

The pair sidecar reduces verification CPU for sparse phrases but adds discovery
I/O. In this run it improves the stress tail and regresses the legal tail. The
actual sidecar is 86,964,647 bytes including a 63,911-byte root; the 8-MiB combined
binary data is 7,991,555 bytes. Changing the storage allowance does not change
BM25 or permit approximate results.

Multi-pair follow-up used an already-exercised smallest-pair control, so its first
pass is not an equal-cache comparison. In the repeated-page pass, `"and absent a
showing"` fell from 1130 to 407 ms (157 → 46 verified documents); `"court cause
number 2010"` fell from 637 to 427 ms (62 → 20). `"on that advice appellant"`
remained about 2 seconds because useful rare adjacencies were absent from the
selected sidecar. This motivates testing compact storage of all rare pairs,
selected solely from corpus statistics.

## Reproduction

Run from the repository root with the existing 100k source/global index and
calibration artifacts. No benchmark query is supplied to pair construction.

```sh
npm run global:build-pairs -- bench/generated/flp-100000/corpus.jsonl \
  bench/generated/flp-100000/source work/global-100k work/pairs-fresh 128 4096
GLOBAL_PAIRS=work/pairs-fresh node --import tsx bench/global-phrase-matrix.ts
# Explicit controls: GLOBAL_ADAPTIVE_PROBE=competitive|fused,
# GLOBAL_PAIR_INTERSECT=0|1, GLOBAL_MODES=baseline,adaptive,pairs
GLOBAL_PAIRS=work/pairs-fresh GLOBAL_ADAPTIVE_PROBE=fused \
  GLOBAL_PAIR_INTERSECT=1 npm run global:deploy -- work/global-100k
```

`bench/global-native-competitive.ts` accepts explicit `GLOBAL_NATIVE_VARIANTS`
and `GLOBAL_NATIVE_LABEL`. Its signed-in experiment helper uses ignored local
credentials; the reusable `global:deploy` command creates its own authenticated
uploader. The original native control is the runtime at commit `b7f6560`; keep
that snapshot separate when rebuilding controls.

## Final live comparison

The final matched comparison uses three fresh Worker/cache namespaces: original
`b7f6560`, fused adaptive without a sidecar, and fused adaptive with compact rare
pairs plus bounded multi-pair intersection. All use the 8-MiB index-data budget.
All 192 responses match the oracle; all reached BOS.

| Workload/pass          | Original P50 / P95 | Adaptive P50 / P95 | Adaptive + pairs P50 / P95 |
| ---------------------- | -----------------: | -----------------: | -------------------------: |
| Legal, unfamiliar      |      821 / 1850 ms |      716 / 1591 ms |             1116 / 2032 ms |
| Stress, unfamiliar     |    1005 / 37140 ms |      990 / 4218 ms |              946 / 2916 ms |
| Legal, repeated pages  |      335 / 1200 ms |       155 / 859 ms |               164 / 558 ms |
| Stress, repeated pages |     549 / 25159 ms |      347 / 2887 ms |              355 / 1990 ms |

| Difficult phrase             | Original unfamiliar → final | Original repeated pages → final |
| ---------------------------- | --------------------------: | ------------------------------: |
| `"and absent a showing"`     |             37140 → 2277 ms |                  25159 → 484 ms |
| `"on that advice appellant"` |              18693 → 946 ms |                  18364 → 355 ms |
| `"court cause number 2010"`  |             16476 → 1056 ms |                   16073 → 97 ms |

Unfamiliar stress mean R2 requests fall from 168.56 to 24.63, and mean transferred
bytes from 42.14 to 6.03 MiB. Zero-R2 responses stay at 6.25% on the unfamiliar
sets; on repeated stress pages they rise from 81.25% to 100%. Zero R2 requests can
still involve shared Cache API reads; this does not mean bundle-only execution.
The runtime never caches complete search responses.

The final stress P95 is now a proximity query (`subject /5 matter jurisdiction`),
not either originally pathological phrase. Repeated-page proximity queries still
reach about two seconds. The 200–400-ms goal is therefore **not consistently met**.
The pair-enabled first-pass legal set also regresses (P50 821→1116ms, P95
1850→2032ms). Pair discovery has a real cost. Unchanged plain-term paths varied
materially between Worker names, so small wall-time differences in this single
run should not be interpreted as statistically established wins. These are
low-load measurements, not a concurrency or multi-colo capacity test.

The compact sidecar costs 125,980,936 bytes (120.1 MiB) in total, including a
151,816-byte bundled root (148.3 KiB); the base R2 packs are unchanged. The combined
8-MiB binary data is 8,079,460 bytes. All rare-pair selection uses corpus DF,
not these queries. Root/packs are generation-pinned and immutable.

The fused probe is the new global-engine default. Pair construction and use remain
explicit options; the full-corpus production demo has not been migrated. The
[experimental final API](https://work-search-phrase-final.phulin.workers.dev/search?q=%22on%20that%20advice%20appellant%22)
serves this 100k corpus. Deploying the measured profile requires
`GLOBAL_PAIRS=... GLOBAL_PAIR_INTERSECT=1` (fused probing is now the default).

Next high-value work is broad-proximity verification, tighter bounds for broad
Boolean queries (which dominate the final cold simulation tail), and reducing
complete-result read amplification. Further pair coverage needs a broader vocabulary or a complete
pair-presence directory; an absent optional pair currently falls back safely.
Do not silently treat an unindexed pair as a zero-match proof.

Wrangler reported 7,984.36 KiB total upload (code plus both binary modules),
4,334.29 KiB gzip, and 208 ms startup for the final 8-MiB experiment deployment
(version `24591033-dc5e-43d8-98ba-60261778b4df`). This is Wrangler deployment
validation, not a distribution of user-visible cold starts. The larger budgets
were tested locally; their native startup and isolate memory were not measured.

Final matrix reproduction (the benchmark harness pins the earlier probe unless
explicitly overridden, so preserve these flags):

```sh
npm run global:build-pairs -- bench/generated/flp-100000/corpus.jsonl \
  bench/generated/flp-100000/source work/global-100k work/pairs-fresh-inline \
  256 4096 --inline-rare --max-root-bytes 460964
GLOBAL_PAIRS=work/pairs-fresh-inline GLOBAL_MATRIX_LABEL=phrase-final \
  GLOBAL_ADAPTIVE_PROBE=fused GLOBAL_PAIR_INTERSECT=1 \
  node --import tsx bench/global-phrase-matrix.ts
```

## Final four-budget local matrix

All 768 final matrix responses matched the source oracle (32 queries × 3 variants
× 4 budgets × 2 storage modes). Scores use a relative comparison tolerance of 1e-11.
The table below uses calibrated cold-storage simulation, with no shared cache.

| Budget | Combined binary MiB | Stress P95, original / adaptive / pairs (s) | Mean stress GETs, original → pairs | Mean stress MiB, original → pairs |
| -----: | ------------------: | ------------------------------------------: | ---------------------------------: | --------------------------------: |
|  8 MiB |                7.71 |                         51.52 / 5.36 / 4.86 |                     380.69 → 71.50 |                     95.17 → 17.73 |
| 16 MiB |               15.03 |                         51.13 / 5.40 / 4.85 |                     380.56 → 71.31 |                     95.14 → 17.69 |
| 32 MiB |               29.64 |                         51.65 / 5.45 / 4.88 |                     380.06 → 71.19 |                     95.02 → 17.66 |
| 48 MiB |               44.20 |                         51.55 / 5.45 / 4.85 |                     379.56 → 70.75 |                     94.89 → 17.55 |

| Budget | Legal P95, original / adaptive / pairs (ms) | Stress mean process CPU, original / adaptive / pairs (ms) | CPU-control process peak RSS MiB |
| -----: | ------------------------------------------: | --------------------------------------------------------: | -------------------------------: |
|  8 MiB |                          2877 / 2893 / 3336 |                                           868 / 296 / 139 |                              570 |
| 16 MiB |                          2786 / 2764 / 3237 |                                           880 / 300 / 151 |                              584 |
| 32 MiB |                          2713 / 2718 / 3177 |                                           897 / 318 / 150 |                              628 |
| 48 MiB |                          2745 / 2742 / 3185 |                                           871 / 292 / 144 |                              656 |

Cold zero-R2 rates are 6.25% for the legal set and 0% for the stress set at each
budget; larger bundles do not materially change these common-term query paths.
CPU columns use the no-delay controls and include filesystem/adapter/harness
work. RSS is the peak of the entire Node process across all variants, including
the legacy oracle index and retained heap, **not per-query Worker memory**.

[Machine-readable summaries](results/phrases-v1/summary.json),
[generation/bundle/code hashes](results/phrases-v1/manifest.json), and
[compressed raw runs](results/phrases-v1/) accompany this report. Earlier selector,
probe and storage-budget experiments are retained, including the 32 MiB pilot.
That initial local pilot overlapped construction/testing; its timings are
exploratory, not the final CPU comparison.

Validation: `npm run check`; all 172 tests in 33 files passed, including workerd/R2/Cache
API integration, shared budget exhaustion, Unicode, corruption/version/pinning,
fields, title boosts, Boolean logic, exact alignment, ties and pagination.
