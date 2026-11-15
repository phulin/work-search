# Writing positions directly into posting rows

The constructor now determines the bit width for each field, allocates the final
posting row once, and writes both position streams into that buffer through one
Uint32Array view. It no longer allocates temporary body/title encodings, creates
their DataViews, or copies them into the row. The first delta is always zero and
need not be written. Constant streams require only their headers.

The general `pack()` encoder and the decoder are unchanged. The new writer emits
the same bytes, including restart values, delta flags, reserved bytes and padding.
The existing unsigned integer, sortedness and field validation are retained.
No serving format, query execution, context, scoring or presentation changes are
included. The running 1M build retains its original deployed Worker.

Tests compare bytes against the general encoder for all widths from 0 to 32,
unsigned limits, empty and constant streams, nonzero restarts, word boundaries,
and tails around 128 entries. They also independently decode the resulting
streams, check a literal byte fixture, and reject invalid positions in either
field. All 325 tests in 88 files, TypeScript checking and formatting passed.

## Local diagnostic

The same first 512 archived court cases were ingested in local workerd using the
compiled control and optimized Workers. Repeating after the test suite finished:

| Local measurement | Control | Direct writer |
|---|---:|---:|
| Estimated cumulative allocation | 314.0 MiB | 283.6 MiB |
| CPU profiler sampled time | 752 ms | 654 ms |

An earlier direct-writer observation, overlapping tests, estimated 278.6 MiB
allocated. The previous control observation estimated 305.4 MiB. These are sampled
allocations, not retained memory or native Cloudflare peaks. There were only two
heap samples during each request; their maxima miss the peak and must not be
used to claim a large reduction in peak memory. Forced collection was unavailable.
The repeated local profiles show DataView creation falling from 9.3% to 4.2% of sampled time,
but native measurements are needed to assess CPU performance in Cloudflare.

## Worker comparison

The control is the compiled constructor from the preceding ingestion optimization:
`6483d0be2549c53a1d3abd79205180c7648103607ad0b4ff99de2469293ac117`.
The optimized code is
`3704a75c59f8f9d0796341371b309ea41861a221811936f08fb2cfc7629651a5`.
Their source trees differ only in `construction/runs.ts`.

The experiment uses 512-document requests at offsets 0, 100000, 500000 and 900000,
with ten observations per range and variant: 80 requests in randomized interleaved
order, concurrency one. Native CPU/wall observations are joined by CF-Ray. Every
expanded posting byte and each request's document bounds and field totals must
match the control. Verification downloads are separate from ingestion latency.
Opaque R2 backend caches are uncontrolled.

The first session used 9.1% less total CPU (93,282 → 84,809 ms), with a bootstrap
95% interval for the reduction of −5.7% to 22.3%. That interval includes a
slowdown. This is not proof of a consistent native CPU improvement.

| First document | Control median CPU | Direct median CPU | Reduction | Control median client | Direct median client |
|---|---:|---:|---:|---:|---:|
| 0 | 2,853 ms | 1,930 ms | 32.4% | 4,543 ms | 3,441 ms |
| 100,000 | 2,198 ms | 1,668 ms | 24.1% | 3,706 ms | 3,052 ms |
| 500,000 | 1,083 ms | 944 ms | 12.8% | 2,354 ms | 2,321 ms |
| 900,000 | 2,173 ms | 2,523 ms | −16.1% | 3,622 ms | 3,914 ms |

All 80 requests passed decoded-byte and field-total comparisons. One range
regressed in CPU and client time. Native CPU varied substantially between requests;
the experiment does not establish its cause. The full measurements, I/O and
configuration are in `bench/results/columnar/construction-v3/cpu/positions.json`.

A second session repeated offset 900000 and added offsets 250000, 750000 and
950000, with five observations per range/variant and random seed 451817.
Requested counts were 512; the 250000 range returned 443 documents under the
existing ingestion bounds. Both variants returned identical bounds and data.
The other ranges returned 512 documents. This session used 14.8% less total CPU
(76,810 → 65,424 ms), with a bootstrap 95% reduction interval of −1.4% to 28.2%.

| First document | Control median CPU | Direct median CPU | Reduction | Control median client | Direct median client |
|---|---:|---:|---:|---:|---:|
| 900,000 | 2,045 ms | 2,119 ms | −3.6% | 3,616 ms | 3,545 ms |
| 250,000 | 4,282 ms | 2,876 ms | 32.8% | 5,912 ms | 4,212 ms |
| 750,000 | 4,111 ms | 2,944 ms | 28.4% | 5,512 ms | 4,495 ms |
| 950,000 | 4,774 ms | 3,652 ms | 23.5% | 6,615 ms | 5,517 ms |

All 40 additional requests passed decoded-byte and field-total comparisons.
The CPU regression at offset 900000 remained, with a smaller median difference;
its client latency improved slightly. These samples do not establish a uniform
CPU improvement. Both sessions are retained separately rather than treating the
selected ranges as a representative sample of the whole corpus. The implementation
remains on the normal path because it preserves bytes, reduces allocations, and
improved aggregate measured CPU in both sessions. It has not eliminated all
regressions or established a complete-build speedup.

The second report is `cpu/positions-heldout.json`. Repeated local memory reports
and compressed CPU/allocation profiles are stored alongside it. Native peak and
retained memory remain unmeasured. Temporary comparison Workers were removed
after collecting the measurements; the 1M constructor was not replaced.

Reproduce with `construction-ingest-cpu.ts` and
`construction-ingest-cpu-report.ts`, as described in
[CONSTRUCTION-CPU.md](CONSTRUCTION-CPU.md), setting
`CWS_INGEST_COUNT=512 CWS_INGEST_REPETITIONS=10`. Use separate isolated deployments
and Wrangler JSON tails. Local profiles use `construction-memory.ts` with
`CWS_PROFILE_INGEST_ONLY=1`.
