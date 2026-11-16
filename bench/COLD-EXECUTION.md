# Cold search execution, 1M court cases

The planner now prices optional pair context before reading it, avoids pairs whose
context is already proved, and executes routed complete phrase descriptors the
same way as bundled descriptors. Planning reads numeric document sizes without
creating result keys, and reuses validation of packed directory columns.

Short exact phrases can finish matching first, then read complete frequency
packets concurrently. Only document IDs are unpacked for candidate-overlapping
score blocks; frequencies and field lengths are accessed directly for verified
matches. Scoring still uses the original distinct-word BM25 contributions,
float64 arithmetic, fields, title boosts, ties and cursors. Presentation uses the
existing code. No index-format, context or excerpt changes are required.

Complete-list reads use stable extent cache identities and avoid splitting a
list into pages and assembling it again. Sparse block execution still uses
256 KiB pages. The initial eligibility budgets are 16 MiB of frequencies,
20 MiB of estimated physical footprint, 4 MiB of pair context and 131,072
possible matching documents. These select an executor; they never truncate
matches. Larger queries retain block execution. The cost comparison also
considers estimated score-block coverage and fetch phases.

## Live measurements

Corpus: 1,000,000 court cases, 2,503,094 normalized terms, 44,815,427 pairs,
complete previous/next occurrence context. Machine-readable results record the
corpus generation, Worker versions, options and request/isolate identifiers.

Every measured request resets application caches in that request and uses a
fresh shared-cache namespace. Exact totals and response caching are off;
metadata and snippets are included. Requests originate in New England/BOS.
These conditions do not create a fresh isolate or control opaque R2 caches.

The first interleaved 200-query comparison used three repetitions per query per
engine:

| Client latency      | Frozen control | Planner/CPU changes |
| ------------------- | -------------: | ------------------: |
| P50                 |       1,366 ms |            1,184 ms |
| P95                 |       4,369 ms |            3,135 ms |
| P99                 |       7,328 ms |            4,485 ms |
| Successful requests |        600/600 |             596/600 |

All successful responses agreed on ranked IDs/order, display fields and snippets;
scores use a relative tolerance of 1e-10. The candidate had three empty 500s and
one admission rejection. Additional phrase experiments overlapped part of this
run and placed extra load on the candidate. Treat this as exploratory evidence,
not a clean load comparison. CPU observations cover 600 control and 355 candidate
responses. A separate, nonoverlapping comparison follows the cancellation fix.

The final phrase pilot compares complete frequency reads with the preceding
block executor. Five cold requests per query per engine, randomized/interleaved:

| Phrase                        | Client median, blocks → complete | CPU median, blocks → complete | R2 GETs |
| ----------------------------- | -------------------------------: | ----------------------------: | ------: |
| newly discovered evidence     |                 1,247 → 1,037 ms |                  357 → 268 ms | 39 → 28 |
| leave to amend                |                 1,458 → 1,417 ms |                  520 → 405 ms | 56 → 36 |
| third party beneficiary       |                   1,402 → 944 ms |                  337 → 216 ms | 39 → 27 |
| in the absence of             |                 2,177 → 1,465 ms |                  901 → 720 ms | 83 → 47 |
| clear and convincing evidence |                 2,246 → 1,256 ms |                  962 → 472 ms | 63 → 36 |
| burden of proving             |                 1,740 → 1,107 ms |                  575 → 423 ms | 52 → 34 |

The block control had one capacity rejection in this pilot; medians exclude
failed responses and the failure remains in the raw results. No candidate
failures or result differences occurred. Five requests are insufficient for
tail estimates. The complete scorer reduces score I/O phases from 7–8 to one.
Its larger number of decoded document IDs does not imply decoding every row's
frequency columns or calculating every row's BM25 score.

## Reliability and rejected experiments

Dictionary decompression previously shared a semaphore across requests. A native
workerd regression test demonstrates that an abandoned lookup leaves later
requests returning “hung and would never generate a response.” Request-local
scheduling fixes the reproduction while retaining the shared validated-data
cache. This establishes a real failure mode consistent with the live symptoms;
the empty live 500s did not contain enough information to prove their cause.

An earlier complete-frequency implementation decoded all five numeric columns
in overlapping blocks. It raised CPU and regressed burden in its first live
pilot. Direct frequency access for matching rows removed that cost. A separate
attempt to append pair positions without temporary result arrays had inconsistent
CPU results and was removed.

Validation includes the 76-query independent live oracle, exhaustive small-corpus
comparisons, metadata filters, field boosts, repeated terms, zero-hit phrases,
ties, pagination, totals and snippets. The 200-query comparison supplements
rather than replaces that oracle. Results and intermediate experiments are under
`bench/results/columnar/cold-routing-1m/`; `compare-cold.ts`, `compare-report.ts`
and `profile-cold.ts` reproduce the measurement procedures.

Remaining work is to repeat the full workload without overlapping search runs,
investigate regressions with unchanged read/byte counts, and test concurrent
memory and admission behavior. These samples do not establish production P99 or
readiness for 10M documents. The suffix experiment remains separate.
