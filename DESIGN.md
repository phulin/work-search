# Design decisions

- **TypeScript throughout.** WASM would add a second toolchain and boundary costs before profiling establishes a gain. Workers import a Data binary module; startup constructs binary views, a few scalar values and a one-bit-per-document-block validation bitmap, without rebuilding maps or parsing a JSON dictionary.
- **Sorted offset dictionary.** Every term has a 40-byte fixed-width descriptor and UTF-8 string bytes. Binary search decodes O(log vocabulary) terms. Front coding would save shared prefixes but requires block anchors and within-block decoding. An FST offers suffix sharing but increases builder/decoder complexity. The plain format is the correctness baseline; corpus dictionary measurements tell us whether front coding is worthwhile.
- **Variable-byte document gaps and two TFs.** Compact and portable; one decoder handles local and remote bytes. Per-list CRC32 catches payload damage without a remote integrity lookup. Typed arrays avoid one JS object per decoded posting. Format v4 separates frequency triples and position gaps into independently described, checksummed streams. Boolean queries read frequencies only; positional queries attach only the term streams whose locations are needed. Position headers bind to the CRC of their frequency bytes. This requires rebuilding v3 generations but keeps the optimized candidate-local positional matcher.
- **Separate document data.** External IDs, body/title lengths and metadata locations live in the bundle, ensuring ID-only results need no metadata I/O. Metadata is JSON only for individual documents, packed into binary range-addressable objects; no large index structure is JSON. Format v2 compresses 32-document restart blocks: per-field minimum plus bit-packed length deltas, UTF-8 front-coded IDs, and contiguous metadata pointers with varint exceptions. Scoring reads lengths directly; only final winners scan at most 32 ID/pointer records. There is no full-table expansion. A lazy CRC32 per block covers all document data, with a one-bit validation cache per block. IDs that share few prefixes or highly variable lengths/pointers compress less; budget feasibility remains corpus-dependent. A block size of 32 trades a modest directory/header cost for bounded winner decoding.
- **Length hot path.** A single cached header holds seven numeric scalars for the most recently accessed 32-document block. Sorted scoring candidates reuse its validated offsets, minima and widths. Constant columns return minima directly; variable deltas use byte/bit extraction instead of an exponentiation loop. CRC and geometry checks still run on every first block visit, and each public access validates the document ID. The scoring loop also reuses one caller-owned length-result object per search, avoiding candidate-count allocation; default public reads still return independent objects. No per-document decoded cache, binary change or budget increase is needed.
- **External sorting.** Input chunks spill term-sorted postings; bounded 32-way merge passes preserve original document order. A temporary on-disk SQLite table detects duplicate IDs. Its transaction avoids per-document fsync; it is disposable scratch, not serving infrastructure. Document tables, vocabulary, a chunk, the largest term, and final bundle remain resident. This is not an unbounded in-memory inverted index, but is also not a constant-memory builder.
- **Immutable generation.** SHA-256 of format/config and ordered normalized JSON input determines the prefix. Spill size is deliberately excluded. Manifest object hashes verify upload inputs; generation-tagged R2 objects and list CRCs enforce bundle/object compatibility during reads. The builder refuses existing generation paths. Manifest is written last; partially built outputs cannot deploy through the CLI. SHA metadata on existing cloud objects assumes exclusive, trusted write access; it is not a defense against a malicious bucket writer.
- **Selection policies.** Smallest-first is a stable length/term sort. Workload policy greedily purchases complete term sets for AND queries by incremental completed-query gain per byte, then fills by individual query-term frequency per byte. It captures multi-term interactions but is a heuristic, not a globally optimal knapsack solution. Query packages make it expensive for very large unique workloads; aggregate/sampling and lazy gains should follow. Benchmark training and evaluation on the same workload is explicitly optimistic; supply held-out queries for deployment decisions.
- **Query language.** A bounded Pratt parser implements explicit Boolean groups, Lexis-style OR-first priority, phrases and positional connectors. `/s` and `/p` use 25/75-token distances, not sentence boundaries. Exact sorted candidate sets serve Boolean queries; positional queries first compute safe coarse sets, then evaluate candidate-local field spans. NOT involving positional expressions never subtracts an approximate set. The documented span algebra is a defined subset, not a claim to reproduce every vendor expansion or implicit phrase rule. `docs/QUERY.md` specifies semantics and safeguards.
- **Compiled positional execution.** Query-local compiled plans replace candidate-local Maps. Per-term exact-capacity position scratch avoids repeated typed-array allocation. Phrase existence anchors at the shortest list; proximity existence sweeps ordered intervals or binary-searches when nested ends are not monotone. Compound parents request complete location lists, with windowed joins, sorted OR union and bounded materialization; truth-only leaves short-circuit. The positional evaluator remains independent of the v4 stream layout. A global 32,768-slot compound-scratch cap and conservative position-buffer growth accounting fit existing memory headroom.
- **Exact search baseline.** Sorted intersections start with the shortest filtered list; OR uses sorted unions. Ranking scans candidates and maintains an O(K) min-heap. Ties use input order. Only final winners decode external IDs. Document frequency is the union across fields, with independent length normalization and boosted title BM25. Exact total is available because all candidates are visited.
- **Resource limits.** Four reads in flight respect the six-connection limit with headroom. At most 16 distinct terms and 100 returned hits. The working-set guard accounts for encoded, decoded, and candidate arrays, with headroom for runtime. It cannot guarantee safety for many concurrent requests. No code or binary budget is presented as proof of deployment viability; workerd and account validation are separate.
- **Block-max score pruning.** Default total=false builds/caches title-aware bounds and safely skips ranking/positional checks for uncompetitive document windows. Exact counts require total=true. That fallback does not avoid frequency decoding; eligible v6–v8 positive queries also support persisted bounds, Boolean block iterators and pivot WAND as documented below.

## Next optimizations

1. Improve cost-based routing and cold R2 block reads for the implemented Boolean/pivot-WAND iterators; persisted score bounds are already available.
2. Profile rare nested conjunctions that still need Cartesian covering spans; add lazy compound iterators if real workloads justify the complexity.
3. Calibrate adaptive range costs on deployed R2 and evaluate mixed embedding/cache locality on larger held-out real query traces.
4. Bound per-isolate concurrent search working sets; a bounded retained cache alone does not solve concurrent request peaks.
5. Incremental design: immutable base plus small delta generations and a bundled tombstone map; query both, resolve external IDs, then compact offline. Not implemented because it changes ID/statistics semantics and deployment consistency.

## Scoring hot path

Positive scoring entries precompute IDF and retain original term order. Each candidate computes body/title normalization once, then uses direct loops over entries. The heap rejects losing candidates before allocating a Hit. Arithmetic operation order matches the previous scorer, including title boosting; exact score and result equivalence are tested against its frozen snapshot. Index bytes and all embedding decisions are unchanged. See bench/SCORING-OPTIMIZATION.md for paired and full-matrix measurements.

## Block postings (v5)

Large lists restart every 256 documents. A checksummed directory of doc ranges, byte offsets, and per-block frequency/position CRCs lives at the front of each frequency stream; small lists retain the compact v4 payloads. This avoids mandatory bundle growth from a separate global block table. All embedded directory bytes consume the same budget as payloads. Remote sparse reads require one prefix read before targeted ranges; full scans keep one range per stream. At-most-four-window coalescing (one window when four save less than 25% of span bytes) trades some transferred gap bytes for bounded requests, but decoding still touches only selected blocks. A single shared four-read semaphore covers all terms and phases.

An obligatory rare term is a safe anchor even in nested Boolean/positional expressions; OR uses the intersection of obligatory term sets and NOT contributes none. Anchor planning is enabled only for an eightfold df disparity. It does not promise optimal I/O on uniformly scattered matches. Decoder output arrays are allocated once; each frequency block decodes directly into its assigned output range using views, without per-block array allocation/copying. Position buffers are retained compressed. The format requires a complete generation rebuild; previous Workers and bundles remain valid only together. Frozen v4 engine/index readers support paired result/score/count and timing checks in bench/paired-blocks.ts. The fifth internal search argument disables anchor skipping for exhaustive equivalence tests; HTTP users cannot select it.

## Block decoder hot path

The v5 index bytes and budgets remain unchanged. Full-list scans bypass sparse selection, run construction, async per-run scheduling and offset rebasing. A dedicated bounded decoder writes frequencies and absolute positional offsets into final arrays, rather than constructing per-block posting objects, typed-array views for every column, and temporary offset tables. Directory decoding reads fixed fields directly without nine-element temporary arrays. One-byte varints return immediately; the existing canonical five-byte fallback validates longer values. Each block still has its own frequency/position CRC, cross-stream binding, sorted IDs/positions, boundary checks and trailing-byte checks. Range-indexed CRC loops avoid iterator/subarray overhead during checksum calculation. No decoded-list or validation cache is added; sparse queries retain the same block/range planning. See bench/BLOCK-DECODING.md.

## Historical mixed-workload, planning, pruning and cache experiments

- `mixed` embedding purchases complete frequency/position query packages jointly, preserving query duplicates as weights. The deterministic heuristic favors complete local queries plus a small avoided-stream-read utility, then fills by read utility per byte. Previous smallest/frequency-first policies remain available. V5 bytes/layout are unchanged; a new placement needs a new generation.
- Adaptive necessary candidate predicates cover rare disjunctions under conjunction/proximity. Selective positional queries combine frequencies before attaching intersecting positional blocks, reusing arrays/directories. Cost-based range partitions select profitable byte gaps under four ranges; 64 KiB per request is an explicit estimated default. Galloping intersections handle skewed lists.
- `total=false` enables exact top-K block-max score pruning after frequency decoding. Maxima are built lazily in 1,024-document windows and use exactly the scorer's arithmetic order. Independent body/title maxima permit configurable boosts and fields without underestimating. This is not pivot-WAND and does not skip frequency decoding; cold bound construction is an explicit cost. Exact totals require explicit total=true; otherwise totals are omitted. Equal-score skips preserve input-order ties; positional matching is delayed until a candidate survives score bounds.
- `SearchRuntime` is a weighted LRU (Worker default 4 MiB; 0–8 configurable) shared by complete verified decoded postings and score maxima. Generation/CRC-scoped keys prevent mixing generations; incomplete positional lists are never stored as complete. Request cursors and attachments stay private. Oversized entries are rejected; conservative query headroom can lower the cache ceiling. The configured capacity is a retained-cache bound, not a guarantee for concurrent search working sets. No arrays are expanded at Worker startup.
- Benchmarks separately measure placement, planning, cache-cold/warm and pruning-cold/warm cases. Identical encoded v5 streams are repacked for policy comparisons; repacking is not reported as document-index throughput. Query-process RSS includes multiple reference index fixtures, so it is not isolate memory. See bench/REMAINING-OPTIMIZATIONS.md.

## Historical seven sequential execution/index experiments

- Scoring cursors now switch from eight sequential steps to galloping seeks.
  With no exact total, documents that cannot beat the heap skip positional
  verification after scoring; only verified hits enter the heap. Sparse candidate
  sets bypass the runtime bound-building scan (threshold 1,024 and at most 8x
  posting/candidate ratio).
- New v8 builds persist separate exact body/title impacts in 52-byte directories.
  Positive Boolean term trees use bounded block cursors and safe block-max
  skipping. AND trees align cursors; OR/mixed positive trees enumerate their union
  and evaluate the Boolean predicate. This is not pivot-WAND. Phrases, negation,
  metadata requests and exact-total queries retain the established executor.
  Broad remote frequency streams deliberately use one read: current streaming
  primarily avoids decoding/allocation, not remote bytes. Local streams use views
  and bounded read-ahead. A full candidate array is not constructed by this path.
- Optional dense-position seek tables avoid a semantic scan of every position.
  CRC/binding/geometry remain eager; accessed rows get semantic validation. Sparse
  positions retain varints because the initial always-on experiment regressed.
- The same bounded LRU now admits directories, verified decoded blocks and remote
  ranges up to 256 KiB. Local decoded lists whose full size exceeds half the cache
  are excluded to avoid scan pollution. Remote block misses fall back to one full
  frequency read to avoid request amplification; hot retained blocks can avoid it.
  Generation/checksum-scoped keys and private cursors preserve request isolation.
- Packed/constant frequency columns compete against legacy varints per block.
  Constant document gaps represent runs; zero/constant title and body columns avoid
  storing repeated values. All format overhead counts against the same budgets.
  Scalar decoding can still lose CPU on irregular distributions; smaller bytes do
  not guarantee faster execution. No phrase accelerators were added.
- Current readers support v5–v8. The builder writes v8; deployment verifies the
  manifest format and exact generation. Internal optimizationStage is a benchmark
  switch only, never an HTTP option. See bench/NEXT-OPTIMIZATIONS.md for sequential
  measurements and limitations. Cache capacity still does not bound simultaneous
  query working sets across an isolate.

## Real-text corpus evaluation

The COLD Cases sampler uses a pinned Harvard/Free Law Project dataset revision.
Shard allocations follow row counts; one row group per shard is selected with
probability proportional to its size, then distinct nonempty decisions are sampled
within it. This reduces source reads while retaining all shards, but is a
clustered sample, not independent uniform sampling. Opinions are concatenated per
decision, without truncation or artificial length normalization. The corpus and
source-row manifest have deterministic serving order and hashes.

The FLP workload is a labeled artificial legal stress test, not a user-query log.
Embedding training and evaluation strings are disjoint. Execution variants share
the same encoded v8 index to isolate executor behavior; varint/v8 storage is
compared separately. Paired variant order and mixed cache traffic are shuffled.
Correctness comparisons and memory sampling occur outside the timer. Historical
next-stage raw measurements retain their original timing boundary; future runs
of bench/next.ts now exclude those validation/sampling costs as well.

## Boolean recovery and pivot WAND

Small/cached mixed AND/OR queries use materialized sorted-set execution. Large
positive trees can use cost-ordered composable iterators: OR produces its union,
AND drives its smallest estimated child, and duplicate term occurrences have
independent cursors sharing immutable term data. Query-local block reuse and the
same complete-posting LRU keys avoid duplicate decoding and permit direct cached
array cursors. Block bounds remain valid over cached document-ID intervals.

Pure disjunctions can use literal pivot WAND with existing global/per-block
impacts. Partial upper bounds are summed in the scorer's original term/field
order, then memoized by subset (at most 512 KiB temporary memory at 16 terms,
charged to the existing working-set guard). This preserves exact scores/ties
without lossy score quantization or new index bytes. Automatic routing considers
query shape, df disparity, top-K, field, and complete cache availability; internal
forced modes exist for validation, not HTTP users. Materialized execution remains
available for exact totals, negation, positions, metadata and small/cached lists.
Remote misses still fetch full frequency streams to avoid amplifying R2 requests;
WAND's cold benefit is CPU/decoded-memory, not a claim of reduced network bytes.
See bench/BOOLEAN-WAND.md for sequential experiments, held-out OR measurements,
local workerd validation and remaining warm-cache tradeoffs.

## Larger real-corpus runs

FLP benchmark scripts accept FLP_ROOT/FLP_PREFIX to isolate corpus sizes and
results; FLP_QUERY_SOURCE freezes the original training/evaluation strings.
Infeasible dictionary/table budgets are retained as failures, never reported as
zero-latency queries. The sampler stores per-shard JSONL checkpoints with hashes
and source rows, then shuffles byte offsets so full texts do not all reside in RAM.
The 100k sample retains the original 10k decisions under the same revision/seed.

JSONL ingestion explicitly splits LF/CRLF records rather than using readline:
recent Node readline versions split literal U+2028/U+2029 inside otherwise-valid
JSON strings. These characters occur in the larger legal sample. The shared
reader preserves their text and is regression-tested across chunk boundaries.

Paged R2 layout (v1): the bundle can contain only a routing root. Terms are routed
by the first term of each 256-term dictionary page. Dictionary pages reuse the
v8 binary dictionary/descriptor decoder. Exact lengths occupy separate 4096-doc
u32 body/title pages, and result records use the existing compressed document
codec in independent 4096-doc pages. Selected ranges are coalesced to at most
256 KiB; streaming frequencies use 64 KiB read-ahead. Directory and block CRCs
remain independently verified. The root and pages are generation-bound; page CRCs
are verified before inserting into the shared weighted LRU. Query-local views
prevent concurrent requests from changing each other's synchronous lookup data.

This implementation prioritizes equivalence and explicit tradeoffs: no new ranking
model, forward index or persistent cursor state. The bundled layout remains the
baseline; the paged layout removes mandatory bundle growth but can add read phases.
Both are supported by the same Worker, CLI, local filesystem and R2 adapters.

Hybrid paged v2 adds opt-in local exact lengths and an independent front-coded
external-ID table. This is a bounded bundle allocation, not a corpus-wide serving
requirement: callers can retain fully remote document tables when these sections
do not fit. Scoring arithmetic and token lengths remain exact. Metadata pointers
stay remote, so metadata retrieval remains a separate measured operation.
Validated routing metadata and immutable local tables are shared across query
views rather than reparsing the routing JSON for every search.

Adaptive reads trade extra bytes for fewer dependent R2 operations. A stream up
to 256 KiB is fetched whole; a larger stream starts with directory + 64 KiB and
increases sequential read-ahead to at most 1 MiB, resetting after a jump. Memory
estimation charges the maximum read window. Fixed reads remain available for
ablations and v1 compatibility. The benchmark's optional bandwidth model reserves
transfer time on one FIFO link shared by a query's concurrent reads; it is a
sensitivity model, not measured R2 behavior.

Paged v3 stores a small hot binary index after local lengths and IDs. Hot entries
can point to either bundled or remote streams, and cold dictionary pages can
carry tiny streams inline. Local reads resolve against the originating binary
index, rather than assuming every local offset belongs to the top-level bundle.
Training terms receive priority; corpus DF fills the hot descriptor allocation.
All serving structures remain binary except the small routing JSON.

Competitive positional verification scores a conservative candidate superset,
sorts by exact score/document-ID tie-breaker, and verifies batches of 64, 256,
then all remaining candidates if needed. It stops only when later scores cannot
beat the verified heap. Measured regressions keep this path opt-in. Ranked
candidate memory is charged to the query guard. The network range planner tests
one through four contiguous groups using largest-gap partitions, estimating
latency waves at the query's available read concurrency plus transferred bytes.
The user explicitly skipped cache-policy optimization; existing LRU behavior stays.

The full-snapshot demo partitions offline input into bounded indexes, then uses
Workers service bindings for a hierarchical fanout. Every partition scores with
the same global document frequencies and field-length statistics. Partition-local
WAND/score bounds are disabled on that path: their original local statistics are
not valid global upper bounds. This trades query speed and R2 operations for
correct ranking while the full import proceeds within local disk/RAM limits.

Signed search-after cursors pin the query, statistics and generation vector for
one hour. Equal scores are ordered by partition then internal document ID.
Pagination re-executes against those immutable partitions without retaining an
ever-growing heap or mutable server-side session. Full opinion bodies live in
separate gzip records with a fixed-width ranged catalog, outside bundle budgets.
Excerpts scan a bounded prefix; the reader streams the entire opinion. This is
a search-and-reading MVP, without court/date filters or citation analysis.

Case display metadata has its own immutable R2 generation, separate from search
postings and opinion text. An offline cluster→docket→court join and reporter
citation lookup recover blank captions and add legal case details to old and new
index partitions alike. A sparse 16-byte cluster catalog points to CRC-protected
gzip-compressed JSON blocks in 64-MiB packs, with a bounded record cache. Blocks
hold at most 256 cases / roughly 256 KiB before compression; the decoder enforces
a 1-MiB expansion limit. The publication pointer
changes only after all objects are present. No title terms, statistics or ranking
change underneath pinned pagination cursors; absent historical title terms require
a later index rebuild. Missing source fields remain explicit gaps.

The demo performance harness freezes all published partition generations and
reuses production gateway/shard handlers locally. Native R2 header/body samples
are stratified by range size and locality, with serial samples supplying intrinsic
delays and burst samples checking queueing. A six-slot header queue is shared
across the local service-binding graph and releases at headers, while body streams
continue independently. Reset/mixed/repeated application caches are distinct from
the unobservable backend cache state. Timed local runs fail on missing mirrored
ranges; hydration happens separately. Measured deployed results and local models
remain separate, with ranking equivalence and prediction-error checks. No query
frequency weights or cache policy are inferred from the scenario suite.
