# Exact packet search for Workers

The primary execution paths are complete term reads and candidate-document reads.
Hierarchical block retrieval handles queries that exceed their budgets. The live
1M implementation and measurements are described in [the benchmark report](COLUMNAR-BENCHMARK.md).
Full-corpus adoption is not yet established. The public demo is unchanged.

## Binary layout

The complete CTD2 term directory is bundled. Every word has a numeric ID, DF,
body/title occurrence counts, direct frequency/position addresses and sizes, and
a block-tree root. UTF-8 names are front-coded in independently compressed
128-term groups. Binary restart keys permit lookup without materializing the
whole vocabulary. Queried groups use a bounded 2 MiB decoded cache. The 1M
corpus has 2,812,380 terms in 33,402,940 bytes. Full-corpus bundle size must be
measured; it is not extrapolated from this result.

CTF3 term frequency/score packets are contiguous, independently addressable
streams. They contain packed document IDs and frequencies, exact float64
body/title BM25 contributions, and a separate numeric document-package handle
column. Positions have their own addresses and restartable offsets. Fetching a
page containing positions never forces positional decoding. Large lists use
bounded contiguous parts and retain their block hierarchy.

Physical objects are at most 64 MiB, cache pages 256 KiB, and decoding blocks
approximately 128 postings. These are independent units: one GET can fetch a
multi-page contiguous packet. Nearby requested ranges coalesce across a gap of
at most one cache page, with an 8 MiB transfer ceiling. Every fetched page is
validated and cached separately. Posting execution uses no general-purpose
compression or per-frame Response/DecompressionStream pipeline.

CDP2 document packages have six independent sections: whole-document term
frequencies and field lengths; body token IDs; title token IDs; compressed display
metadata; a passage index; and compressed text passages. Candidate verification
and exact scoring decode only numeric sections. Winners decode metadata and the
relevant passage. No second remote locator discovery is needed.

A CDD1 bundled directory addresses every document directly. It stores a 32-byte
content digest per group of at most 128 packages, plus packed package offsets.
The document handle determines the exact object key, offset and size before I/O.
One range GET returns the package, with matching generation and package CRC
metadata. Grouping reduces construction PUTs without fetching neighboring
packages. The 1M package directory occupies 2,703,736 bytes; packages occupy
20,143,777,366 bytes.

## Execution

| Plan                  | Selection                                                | Fetch sequence                                                      |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Complete terms        | All necessary streams fit transfer and execution budgets | Fetch streams together; match/rank numerically; fetch winners       |
| Anchor plus documents | Mandatory words or pairs produce few candidate packages  | Fetch/intersect anchors; fetch packages; verify, score and render   |
| Blocks                | Neither simple plan is economical                        | Retrieve bounded ranges in batches; prove completion; fetch winners |

The planner estimates bytes, GET waves, dependent phases, occurrences, and
candidate package work. It can intersect up to eight inexpensive mandatory word
lists or two useful positional pairs from one mandatory phrase. Rarest-term DF
alone does not select the plan. Initial budgets are 8 MiB transfer, 24 MiB
estimated execution memory, and 512 candidate packages. Observed candidate counts
and actual package sizes are checked before package retrieval. Exceeding a
strategy budget switches to complete block coverage; it never drops candidates.

All paths preserve the Boolean AST, fields, negation, repeated terms, phrase and
proximity spans, float64 scores, title boosts, deterministic score/document ties,
search-after, and exact totals when requested. Coarse predicates use three-valued
logic: negative positional conditions remain unknown until verified. Scores keep
the original positive-term accumulation order. Display IDs and pointer objects
are absent from posting loops.

The block fallback uses a corpus-wide hierarchy and batched block-max MAXSCORE.
It visits document ranges in order, reuses physical pages across nearby work,
and uses conservative field bounds rounded outward. Equality remains eligible
for deterministic ties. An unfilled heap supplies no score-pruning threshold.
Sparse anchors restrict ranges and masks; broad phrases use buffered positions.
Resource exhaustion is an explicit error, never incomplete results.

CPP3 corpus-selected pair packets contain documents, field-specific positions,
and one token of context on each side. Empty spans cost no bytes; singleton
spans use three uint32 values; longer spans have separate packed columns.
Context can prove phrases of up to four words, and several contexts can jointly
cover a longer phrase. Pair intersections and context rejection occur before
candidate-package budget decisions. The same evidence survives a switch to
block retrieval and can avoid ordinary word-position decoding. Missing pairs or
uncovered neighborhoods mean unknown, with ordinary exact verification.

All selected descriptors currently fit in the bundled root; there is no remote
pair-discovery stage. A remote pair dictionary has not been implemented or
measured. Selection uses corpus DF, occurrence volume, and estimated verification
work saved per conservative byte, with no benchmark-query input.

## Memory and I/O

The hierarchy is bundle → bounded isolate memory → validated immutable-page
Cache API entries → R2. Packet deployments share one 12 MiB page/package cache,
4 MiB decoded-column cache, and 2 MiB decoded-directory cache across ordinary and
benchmark routes. Bundle bytes, active query buffers and pending shared writes
are additional charges. Two active queries are admitted per isolate; excess
requests receive an explicit 503. Benchmarks record these rejections.

Each request owns its six-slot I/O semaphore and pending-read deduplication.
Validated bytes can cross requests; outstanding promises cannot. Physical pages
own their buffers so an evicted multi-megabyte transfer is not retained through a
small slice. Shared entries carry generation-specific validation identities.
Packages up to 4 MiB enter the shared cache; writes have bounded backpressure.
Larger entries remain bounded by the memory LRU or are read again.

Diagnostics separate R2 requests/bytes, shared operations, memory hits, candidate
packages, decoded postings/positions/context/forward integers, unique/repeated
decoded and inflated bytes, result retrieval, and software buffer/cache charges.
The current stage counter records explicit batches, not a full I/O dependency
DAG. Invocation-memory samples, local inspector heap observations, and cumulative
allocation profiles are distinct metrics. Native peak/retained memory remains
unestablished; production profiling calls currently return 404/code 10393.

## Construction and deployment

The TypeScript constructor runs in one Worker invoked concurrently. A local
TypeScript coordinator schedules jobs and saves checkpoints; bulk corpus,
sorted streams, document packages, and serving objects remain in R2. Ingestion,
balanced merge levels, final term ranges, vocabularies, posting output, and
128-document package groups are separate bounded jobs. Publication verifies
ordered coverage receipts and immutable object identities before exposing a root.
It does not pass the corpus through a single legacy bundled index.

The pair pass scans numeric token sections twice: first to count adjacent pairs,
then to write selected positions/context. Up to 65,536 corpus-selected words use
sparse sorted occurrence keys, not a vocabulary-squared table. Global statistics
merge through 512 KiB chunks with at most four input cursors; occurrence merges
copy encoded spans. Counts retain float64 occurrence totals above 32 bits. The
selection heap is bounded independently of corpus pair vocabulary. The wider
1M pair build is running; its serving benefit is not yet measured.

See the [README commands](../README.md) for construction, resumption, publication,
and isolated deployment. Generations identify the complete immutable layout and
scope all caches. Source checksums and job acknowledgements prevent mixed builds.
A temporary benchmark bridge preserves the compiled constructor of an in-progress
10M source build while newer pair jobs use the same Worker and a shared admission
gate. It should be removed when that build completes. No CI execution service,
Worker pool, Containers, Durable Objects, or external search database is used.

## Alternatives and remaining work

Per-document construction PUTs were replaced by physical groups after native
measurements attributed most job wall time to writes. Page-at-a-time term reads
lost to contiguous transfers in a randomized live comparison. Separate caches
for benchmark and ordinary routes were removed. A Queues dispatcher failed its
application capacity gate and was drained, deleted, and removed from the normal
path. Neither response caching nor approximate candidate truncation explains
these results.

The historical 4f97 control and the later same-corpus 1M block layout remain
separate benchmark controls. Earlier local-builder/head/pair compatibility paths
still exist in source and tooling; removing them from the normal production path
is outstanding. Full-corpus directory/bundle limits, scale-specific latency and
load, final large-sample comparisons, and native retained/peak memory remain
adoption gates. Current Cloudflare limits are documented in the
[official limits](https://developers.cloudflare.com/workers/platform/limits/).
