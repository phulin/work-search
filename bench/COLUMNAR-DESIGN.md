# Exact packet search for Workers

The primary execution paths are complete term reads and candidate-document reads.
Hierarchical block retrieval handles queries that exceed their budgets. The live
1M implementation and measurements are described in [the benchmark report](COLUMNAR-BENCHMARK.md).
Full-corpus adoption is not yet established. The public demo is unchanged.
Further construction and serving experiments are limited to 1M documents until
the format and planner are stable; the 10M build work is stopped.
The primary iteration loop now runs against local 1M data with configurable
R2/cache latency and bandwidth. Immutable data preparation is untimed; timed
replay refuses network reads. Plan comparisons isolate their application and
shared caches, and reuse the production readers/executors. Live Workers validate
finalists after the faster local experiments.

The current [complete-pair experiment](COMPLETE-PAIR-EXPERIMENT.md) replaces
selected-pair coverage with every observed adjacent pair on the local stemmed
1M generation. Its string-routed, self-contained packets use compressed sorted
document lists with independent field membership; there are no bitmap encodings.
The 6.5 MB router stays bundled and packet payloads stay remote. N/M common-anchor
exclusions are planner settings; they never remove matching or scoring data.
These new pair packets have not yet been deployed to Workers.

## Binary layout

CTD3 bundles metadata for at most one million high-DF terms and a compact direct
routing table for the rest. Every term remains indexed. Ties at the bundle
boundary use lexical numeric IDs. Hot metadata contains DF, body/title occurrence
counts, direct frequency/position addresses and sizes, and a block-tree root.
UTF-8 names are front-coded in independently compressed 1,024-term groups. Binary
restart keys permit lookup without materializing the vocabulary. Queried hot
groups use a bounded 2 MiB decoded cache with conservative charges for decoded
maps, names and address records. At most two groups decode concurrently.

Cold routing records contain direct R2 shard references. CTS1 shards contain
compressed metadata plus independently accessible, uncompressed small complete
frequency/position packets. Reading a shard seeds the query reader with those
validated original address spans, including subranges used by block fallback;
matching and scoring need no additional packet GET for those terms. Larger cold
packets keep their existing direct addresses. Shard values use the ordinary
bounded decoded LRU, while read deduplication stays request-local. Cached shards
own their backing buffers; a shard sliced from a coalesced transfer cannot retain
the larger transfer. Only packets requested by the query seed its reader.

The earlier 1M unstemmed CTD2 directory contained 2,812,380 terms in 33,402,940
bytes. During the 10M build its partial directory reached about 116 MB after
10.53M terms, exceeding Workers' bundle limit before completion. This motivated
the explicit common/rare split; shrinking vocabulary by dropping words is not
used. The new directory's full-scale footprint still requires measurement.

The completed stemmed 1M generation contains 2,539,780 terms, with one million
bundled and 1,539,780 remote. Its bundled directory and routing occupy 14,836,106
bytes. Local directory regrouping preserves every decoded term's counts, bounds
and addresses and all cold routing; it permits cache/granularity experiments
without another corpus build or Worker deployment.

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
relevant passage. Packed body scanning stops at the first query-relevant token
when choosing a snippet, without expanding the whole token column. No second
remote locator discovery is needed.

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
are checked before package retrieval, and actual bytes after each batch. Exceeding a
strategy budget switches to complete block coverage; it never drops candidates.

New generations declare `nfkc-lower-porter2-v1`: NFKC and lowercase tokenization
followed once by English Snowball/Porter2 stemming. Ingestion merges variants
before calculating DF, frequencies, positions and float64 BM25 contributions.
Query atoms and phrase/proximity tokens use the same analysis; exact matching is
defined over that normalized token stream. Display spans and positional counts
do not change, and common words remain searchable. Stemming requires a fresh
generation; existing unstemmed benchmark controls retain their original analysis.

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
Nonpositional broad execution can prefetch four nearby ranges within a 2 MiB
physical footprint. Prefetch uses conservative bounds from the current heap;
execution rechecks bounds before decoding. It neither changes coverage nor
materializes a temporary concatenated packet just to warm pages.

CPP3 corpus-selected pair packets contain documents, field-specific positions,
and one token of context on each side. Empty spans cost no bytes; singleton
spans use three uint32 values; longer spans have separate packed columns.
Context can prove phrases of up to four words, and several contexts can jointly
cover a longer phrase. Pair intersections and context rejection occur before
candidate-package budget decisions. The same evidence survives a switch to
block retrieval and can avoid ordinary word-position decoding. Missing pairs or
uncovered neighborhoods mean unknown, with ordinary exact verification.

The existing 4,096-pair deployment bundles descriptors and keeps 733 MB of CPP3
payloads in R2. The expanded format puts descriptors in sorted CPD1 lookup shards;
small complete postings are inline with their dictionary entries. Only 256 hot
descriptors and compact shard fences remain bundled. Query lookup batches up to
eight relevant ranges, then replans using the resulting descriptors. Missing
entries remain unknown. A live native pilot verified every descriptor and inline
packet against its source; the 65,536-pair generation is still being built and
has not established a latency benefit. Its unfinished unstemmed merge was stopped
when stemming was requested; its completed source/statistics checkpoints remain.
Selection uses corpus DF, occurrence
volume, and estimated verification work saved per conservative byte, with no
benchmark-query input. It currently requires at least a twofold DF reduction and
limits individual pair packets to 8 MiB.

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
1M generation contains 4,096 pairs and 19,327,527 occurrences. It showed identical
work counts to the smaller generation on existing scenarios; extra coverage has
not yet established a serving benefit. Large occurrence merges partition sorted
key ranges using restart keys written into chunk descriptors. A live 32-range
replay produced byte-identical final packets, including context, to a full merge.

See the [README commands](../README.md) for construction, resumption, publication,
and isolated deployment. Generations identify the complete immutable layout and
scope all caches. Source checksums and job acknowledgements prevent mixed builds.
A temporary benchmark bridge preserves the compiled constructor of an in-progress
source build while newer jobs use the same Worker and a shared admission
gate. Those unstemmed bulk jobs are now stopped; the temporary bridge must be
removed after the new analysis path is validated. No CI execution service,
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
separate benchmark controls. The former local builder lives under benchmark control
tooling; native construction is the default. Earlier head/legacy-render compatibility
paths still exist in serving source and must be removed after the active builds
and comparisons complete. The immediate acceptance work uses the stemmed 1M
generation: independent exhaustive/reference agreement, complete-term versus
candidate-document crossover measurements, fallback coverage, startup and cache
conditions, and controlled load. No 10M build resumes before these settle the
format and planner. Final large-sample comparisons and native retained/peak memory remain
adoption gates. Current Cloudflare limits are documented in the
[official limits](https://developers.cloudflare.com/workers/platform/limits/).
