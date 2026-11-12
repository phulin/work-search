# Retrieval optimization round 2

Measured on 100,000 Free Law Project opinions against commit `4f97eb4`. No query-workload-selected phrase index was added. Every measured top-20 response was checked for IDs, BM25 scores (relative tolerance 1e-11), title and metadata against the materialized source oracle. Snippets were included in latency measurements. Full-corpus production search/import was not switched.

## Outcome

Do not enable these experiments globally yet. In the final 8 MiB comparison, cold simulated P95 fell from 3,956 to 3,470 ms and reads/query from 52.8 to 48.3. The live repeated adaptive follow-up regressed from 172/987 ms P50/P95 to 320/1,157 ms. Broad Boolean and one broad proximity query improved individually, but the complete workload did not. All new execution switches remain off by default. The next investigation should profile fine-plan decoding/allocation and cache-operation overhead before attempting further global promotion.

## What was implemented, in sequence

1. Mandatory rare-position anchors verify phrases/proximity inside existing independently compressed token frames. Exact coverage proofs and sorted rows are required; title/boundary/negative/unbounded cases fall back. Verified frames can supply excerpts.
2. A corpus-derived, generation-pinned pair-cost synopsis plus local unigram DF avoids unhelpful pair reads. Missing fingerprints are unknown. Useful multi-pair intersections remain. Positional cofetching reuses pages already selected for frequencies, within the original expanded-byte cap.
3. Exact bounded seed completion was implemented and tested, then left off: pilots added reads without reducing visited cells. Conservative 16-document score bounds replace 64-document bounds in a separately packed layout. A live-driven adaptive pass keeps coarse bounds for selective proximity, gates text windows to small/rare candidate sets, and gates cofetching to small candidate sets.

The first maximum-sketch/individual-pair pilots lost useful pair intersections and were rejected. A stricter 25% pair gate was relaxed to 75%. Unconditional windows and fine/cofetch execution regressed some live queries; the adaptive profile is a separate measured follow-up. These outcomes are retained rather than presenting all three as automatic wins.

## Cold simulated R2: all four budgets

Fixed per-page empirical headers/body latency from the earlier real R2 calibration; six header slots, overlapping bodies, 256 KiB physical pages, 8 MiB query page memory, cold per-query memory, no shared cache or response cache. Each budget ran in its own process (four concurrent processes); profiles alternate order by query. CPU is process CPU, and latency includes host scheduling. These are simulated storage results, not deployed Cloudflare latency. The four-stage matrix contains 512 verified responses.

| MiB | Stage   | P50      | P95      | R2 reads/query | CPU mean | Index data bytes |
| --- | ------- | -------- | -------- | -------------- | -------- | ---------------- |
| 8   | pairs   | 1,190 ms | 3,905 ms | 52.8           | 234 ms   | 8,079,460        |
| 8   | windows | 1,172 ms | 4,703 ms | 56.3           | 243 ms   | 8,079,460        |
| 8   | planned | 1,178 ms | 3,897 ms | 52.5           | 228 ms   | 8,366,055        |
| 8   | fine    | 1,125 ms | 3,450 ms | 48.4           | 215 ms   | 8,033,261        |
| 16  | pairs   | 1,203 ms | 3,920 ms | 52.8           | 232 ms   | 15,761,575       |
| 16  | windows | 1,193 ms | 4,682 ms | 56.2           | 226 ms   | 15,761,575       |
| 16  | planned | 1,197 ms | 3,886 ms | 52.5           | 231 ms   | 16,048,170       |
| 16  | fine    | 1,123 ms | 3,452 ms | 48.3           | 220 ms   | 15,722,647       |
| 32  | pairs   | 1,121 ms | 3,949 ms | 52.6           | 237 ms   | 31,081,122       |
| 32  | windows | 1,137 ms | 4,658 ms | 56.0           | 226 ms   | 31,081,122       |
| 32  | planned | 1,119 ms | 3,900 ms | 52.3           | 227 ms   | 31,367,717       |
| 32  | fine    | 1,118 ms | 3,446 ms | 48.1           | 219 ms   | 31,063,338       |
| 48  | pairs   | 1,093 ms | 3,964 ms | 52.2           | 228 ms   | 46,348,930       |
| 48  | windows | 1,107 ms | 4,697 ms | 55.6           | 224 ms   | 46,348,930       |
| 48  | planned | 1,085 ms | 3,938 ms | 51.9           | 242 ms   | 46,635,525       |
| 48  | fine    | 1,119 ms | 3,450 ms | 48.0           | 225 ms   | 46,344,979       |

Stages: `pairs` = original committed executor plus the existing rare/multi-pair sidecar; `windows` = step 1; `planned` = step 2; `fine` = unconditional fine-bound layout without seed completion.

The final adaptive follow-up contains another 256 verified responses:

| MiB | Profile | P50      | P95      | R2 reads/query | CPU mean |
| --- | ------- | -------- | -------- | -------------- | -------- |
| 8   | pairs   | 1,195 ms | 3,956 ms | 52.8           | 223 ms   |
| 8   | hybrid  | 1,114 ms | 3,470 ms | 48.3           | 205 ms   |
| 16  | pairs   | 1,199 ms | 3,948 ms | 52.7           | 228 ms   |
| 16  | hybrid  | 1,119 ms | 3,471 ms | 48.2           | 217 ms   |
| 32  | pairs   | 1,126 ms | 3,889 ms | 52.6           | 219 ms   |
| 32  | hybrid  | 1,121 ms | 3,474 ms | 48.0           | 223 ms   |
| 48  | pairs   | 1,088 ms | 3,896 ms | 52.2           | 227 ms   |
| 48  | hybrid  | 1,129 ms | 3,474 ms | 47.9           | 224 ms   |

## Live Workers, 8 MiB

Four fresh Worker/cache namespaces received identical corpus-frequency, IDs-only index primes, then interleaved unfamiliar queries and a repeated pass. Isolate-local memory was reset before every query. The shared Cache API stores immutable index pages; no complete-response cache exists. All 256 responses matched the source oracle. Client end-to-end latency includes metadata and matching excerpts. All measurements in this run were collected in BOS.

| Profile | Pass                      | P50    | P95      | R2 reads/query |
| ------- | ------------------------- | ------ | -------- | -------------- |
| base    | unfamiliar / index primed | 847 ms | 1,781 ms | 25.7           |
| base    | repeated / pages warm     | 174 ms | 891 ms   | 0.0            |
| window  | unfamiliar / index primed | 853 ms | 2,141 ms | 26.5           |
| window  | repeated / pages warm     | 222 ms | 1,439 ms | 0.0            |
| cost    | unfamiliar / index primed | 818 ms | 1,913 ms | 25.6           |
| cost    | repeated / pages warm     | 204 ms | 1,025 ms | 0.0            |
| fine    | unfamiliar / index primed | 985 ms | 2,213 ms | 25.2           |
| fine    | repeated / pages warm     | 203 ms | 1,133 ms | 0.0            |

The live regressions prompted adaptive retrieval. Its follow-up compares the existing warmed control/fine namespaces with a fresh hybrid namespace, then repeats all queries. **Only the repeated pass is cache-comparable across all three**; first-pass raw results are archived but must not be described as a fair unfamiliar-query comparison. No response cache is used. Another 192 responses matched the oracle.

| Profile | Repeated P50 | Repeated P95 | R2 reads/query |
| ------- | ------------ | ------------ | -------------- |
| base    | 172 ms       | 987 ms       | 0.0            |
| fine    | 162 ms       | 1,114 ms     | 0.0            |
| hybrid  | 320 ms       | 1,157 ms     | 0.0            |

Per-query repeated latency in the adaptive follow-up:

| Query                                   | Control  | Fine     | Adaptive |
| --------------------------------------- | -------- | -------- | -------- |
| summary judgment                        | 378 ms   | 356 ms   | 459 ms   |
| personal jurisdiction                   | 411 ms   | 273 ms   | 338 ms   |
| breach fiduciary duty                   | 172 ms   | 159 ms   | 201 ms   |
| arbitrary capricious agency             | 154 ms   | 126 ms   | 190 ms   |
| "clear and convincing evidence"         | 838 ms   | 321 ms   | 552 ms   |
| "res ipsa loquitur"                     | 121 ms   | 138 ms   | 221 ms   |
| (standing OR mootness) AND jurisdiction | 491 ms   | 254 ms   | 382 ms   |
| (copyright OR trademark) AND injunction | 118 ms   | 144 ms   | 188 ms   |
| qualified AND immunity NOT prison       | 126 ms   | 114 ms   | 430 ms   |
| qualified /s immunity                   | 118 ms   | 162 ms   | 211 ms   |
| contract /10 breach                     | 163 ms   | 149 ms   | 308 ms   |
| notice /p termination                   | 268 ms   | 455 ms   | 387 ms   |
| Christenberry Allen                     | 288 ms   | 72 ms    | 66 ms    |
| Twombly Iqbal                           | 131 ms   | 109 ms   | 355 ms   |
| court                                   | 36 ms    | 43 ms    | 49 ms    |
| unfindablebenchmarkzzzz                 | 38 ms    | 38 ms    | 42 ms    |
| res judicata                            | 80 ms    | 100 ms   | 320 ms   |
| the pennsylvania                        | 441 ms   | 179 ms   | 243 ms   |
| breach contract                         | 127 ms   | 141 ms   | 162 ms   |
| fiduciary duty                          | 124 ms   | 115 ms   | 196 ms   |
| "court cause number 2010"               | 88 ms    | 124 ms   | 197 ms   |
| "strict scrutiny"                       | 113 ms   | 135 ms   | 143 ms   |
| "and absent a showing"                  | 381 ms   | 482 ms   | 620 ms   |
| "on that advice appellant"              | 170 ms   | 221 ms   | 238 ms   |
| this /5 of                              | 821 ms   | 780 ms   | 1,016 ms |
| motion /5 ten                           | 703 ms   | 1,114 ms | 1,157 ms |
| prosecutorial /5 by                     | 341 ms   | 298 ms   | 499 ms   |
| subject /5 matter jurisdiction          | 2,039 ms | 1,563 ms | 1,616 ms |
| (fiduciary OR duty) AND court           | 471 ms   | 259 ms   | 376 ms   |
| (agreement OR 632was) AND by            | 348 ms   | 573 ms   | 507 ms   |
| (any OR oral) AND because               | 987 ms   | 524 ms   | 595 ms   |
| ("and" OR his) AND was                  | 385 ms   | 315 ms   | 348 ms   |

## CPU, startup, memory and storage

Live CPU comes from sanitized Cloudflare tail events, including the provider's request lifecycle/deferred work. Tail coverage can be sampled. CPU tables aggregate both passes and are not a substitute for matched client latency; the adaptive run has different first-pass cache histories. Expected main-query coverage is 64 per Worker. Raw authorization headers were never archived.

| Run                       | Profile | CPU samples | CPU P50 | CPU P95  | CPU mean |
| ------------------------- | ------- | ----------- | ------- | -------- | -------- |
| retrieval-final-native    | base    | 51/64       | 144 ms  | 804 ms   | 256 ms   |
| retrieval-final-native    | window  | 49/64       | 151 ms  | 1,198 ms | 319 ms   |
| retrieval-final-native    | cost    | 49/64       | 141 ms  | 744 ms   | 286 ms   |
| retrieval-final-native    | fine    | 50/64       | 143 ms  | 869 ms   | 253 ms   |
| retrieval-adaptive-native | base    | 42/64       | 145 ms  | 648 ms   | 273 ms   |
| retrieval-adaptive-native | fine    | 38/64       | 168 ms  | 1,028 ms | 264 ms   |
| retrieval-adaptive-native | hybrid  | 41/64       | 219 ms  | 949 ms   | 307 ms   |

Wrangler measured deployment startup (one observation, not a startup distribution):

| Profile | Startup | Total upload KiB | Gzip KiB |
| ------- | ------- | ---------------- | -------- |
| base    | 200 ms  | 7984.83          | 4334.33  |
| window  | 196 ms  | 8007.21          | 4339.49  |
| cost    | 166 ms  | 8287.18          | 4558.77  |
| fine    | 268 ms  | 7962.19          | 4635.18  |

The new layout adds 701,825,024 bytes (0.654 GiB) of immutable plan data; 6,875,840,512 original bytes are shared. Only the new 11 objects were uploaded. Binary bundle budgets include the base root, pair root and synopsis; code/runtime overhead is separate and Wrangler's gzip deployment sizes are shown above. Fine/hybrid combined binary bytes are 8,033,261 / 15,722,647 / 31,063,338 / 46,344,979. The synopsis is 286,595 bytes and took about 6.6 seconds to build; fine-plan construction took 274.8 seconds excluding subsequent display-head packing.

The simulated process peak RSS includes the legacy oracle, Node buffers and retained GC heap; it is **not Worker isolate memory**. Its per-profile values are in summary.json. Actual peak isolate memory was not exposed by this harness. Native testing used 8 MiB only; 16/32/48 MiB results above are local simulation, not live memory/startup validation.

## Interpretation and limitations

These are 32 scenarios, not a representative user traffic distribution. P95 is nearest rank over 32 values (second slowest); within 16-query legal/stress groups it is the slowest. Group statistics, individual traces, bytes, storage stages and zero-R2 percentages are in the machine-readable files. Broad proximity still takes well over the experimental 200–400 ms complete-response goal. Larger bundles do not automatically help this page-heavy workload. Repeat runs and fresh-cache adaptive tests are needed before changing production defaults.

Seed completion remains implemented but off. Bare windows should not be promoted globally: their cold-read regressions are real. The adaptive profile is opt-in and the full-corpus production demo stays unchanged. No claim is made that the full FLP corpus or 48 MiB isolates received these measured gains.

## Reproduce

```sh
npm ci
npm run check && npm test
# Existing 100k source/global/pair generations and calibration are required.
npm run global:build-pair-costs -- work/pairs-100k-v4096-inline256 work/global-100k/bundle-heads-8.bin
npm run global:refine-bounds -- work/global-100k work/global-100k-fine16-new 16 438411
mkdir -p work/retrieval-round2/baseline
git archive 4f97eb4 src | tar -x -C work/retrieval-round2/baseline
GLOBAL_BASELINE_SEARCH=work/retrieval-round2/baseline/src/global/search.ts \
GLOBAL_PAIRS=work/pairs-100k-v4096-inline256 GLOBAL_FINE_DIR=work/global-100k-fine16-new \
GLOBAL_MATRIX_LABEL=retrieval-check GLOBAL_MATRIX_CONCURRENCY=4 \
GLOBAL_PROFILES=pairs,windows,planned,fine npm run bench:global-retrieval
# Follow-up: GLOBAL_PROFILES=pairs,hybrid and a new matrix label.
# Deploy separate Workers first; credentials and buckets are account-specific.
GLOBAL_NATIVE_VARIANTS=worker-control,worker-experiment \
GLOBAL_NATIVE_LABEL=my-live-run npm run bench:global-native-retrieval
```

The native harness uses the configured phulin.workers.dev benchmark account and per-Worker deploy configs; adapt that hostname and local secret location for another account. Generic publication is `global:deploy`, with `GLOBAL_PAIR_COSTS=1 GLOBAL_TOKEN_WINDOWS=1 GLOBAL_COFETCH_POSITIONS=1 GLOBAL_ADAPTIVE_RETRIEVAL=1 GLOBAL_PAIR_INTERSECT=1`. Seed completion stays off. See README for deployment and safe layout retention. Run `npx tsx bench/global-retrieval-report.ts` with the recorded input paths to regenerate this report.
