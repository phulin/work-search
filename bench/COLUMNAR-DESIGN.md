# CWS1 exact search for Workers

Status: implemented and deployed to isolated benchmark Workers. Adoption depends
on the live and scale results in [COLUMNAR-BENCHMARK.md](COLUMNAR-BENCHMARK.md).
The public demo is unchanged. The archived control is commit
`4f97eb49f1aa2115fbc3026c4924a1182a90917b`; this checkout began at
`dd08b3c943362af8a3d404ed5cb6bc28d402b914`.

## Representation

### Current packet format

The replacement's primary plans are complete term reads and candidate-document
reads. Hierarchical block retrieval is their bounded fallback. The existing CWS1
numeric block kernel is reused inside the new packets; the older serving layout
is retained separately as the same-corpus benchmark control.

`directory.bin` bundles every word, DF, body/title occurrence counts, complete
frequency and position stream references, and a block-tree root. CTD2 front-codes
UTF-8 vocabulary in independently gzip-compressed 128-term groups. Binary restart
keys permit lookup without constructing all vocabulary strings or term objects.
Only queried groups enter a bounded 2 MiB decoded cache. Exact occurrence counts
come from posting frequencies. Tiny leaf bounds use a conservative BM25 maximum;
larger roots retain float64 maxima. The actual 1M packet directory contains
2,812,380 terms in 33,402,940 bytes. The earlier 25,440,253-byte metadata diagnostic
had placeholder occurrence counts and is superseded by that measurement.

CTF3 frequency packets contain document-ordered packed blocks, unchanged float64
field scores, and a separate numeric document-package handle column. Position
streams are independently addressed. Large terms use a bounded sequence of
contiguous parts and retain their block hierarchy. A packet GET can span multiple
256 KiB cache pages; adjacent ranges may coalesce across a page-sized gap into
an at-most-8 MiB transfer. Every fetched page is validated and cached separately.
No posting packet uses general-purpose decompression.

CDP2 document packages have separately decoded whole-document frequency/length
statistics, numeric body/title token IDs, compressed metadata, a passage index,
and compressed text passages. A document handle directly determines its immutable
R2 key. Candidate verification and exact BM25 scoring need no display inflation.
Winning packages supply metadata and a query-relevant passage without another
remote discovery stage. Result retrieval uses packages for all three plans.
Physical document groups collect at most 128 independently readable CDP2 packages
into one immutable object. A bundled CDD1 directory stores a 32-byte object digest
per group plus packed package offsets. Given a document handle, it yields the
exact key, byte offset and length before any remote read. One range GET returns
the candidate package; the same response carries its generation and CRC metadata.
Groups reduce construction PUTs without fetching neighboring documents at serving
time. The 1,000-document pilot's address directory occupied 2,656 bytes.

The initial planner estimates transfer bytes, occurrences, candidate packages,
GET batches and dependent phases. It can intersect cheap mandatory word lists in
its first phase. It never truncates candidates: unexpected candidate counts or
package bytes cause a complete fallback. Initial budgets are 8 MiB transfer,
24 MiB estimated execution memory, and 512 candidate packages. These are strategy
budgets, not matching limits, and still require 1M crossover calibration. Complete
term execution preserves the full AST, score accumulation order, negative
positional predicates, exact totals and search-after ties.

Packet deployments initially reserve 12 MiB for immutable page/package bytes,
4 MiB for decoded columns, and 2 MiB for decoded term-directory groups; bundled
directory bytes and active query buffers are additional memory. Package inflation,
forward integers, positional integers, coalescing, and winner retrieval are counted
separately. Native invocation-memory quantiles do not establish peak or retained
memory. The authenticated forced-plan route lives only in the benchmark entry
point, outside the production planner.

Native packet construction streams source block trees with bounded continuations;
it never flattens a common term's complete tree. Document jobs use range vocabularies
and archived source partitions, with one grouped immutable write per bounded
document range. One builder deployment handles concurrent invocations. The
coordinator backs off on admission rejections. Package publication reduces ordered
write acknowledgements in groups before checking full generation coverage.

CPP3 selected-pair packets retain occurrence positions and one token on each side.
Empty fields consume no span bytes; a singleton uses three direct uint32 values.
Longer spans have separate packed position and context columns. Native pair
construction scans numeric document tokens twice: first for corpus-wide adjacent
pair counts, then for selected occurrence columns. Four-way merge levels bound
memory; occurrence merges copy encoded spans without decoding positions. The
selection budget uses document/occurrence counts and estimated verification work
saved per conservative byte. It has no query input. The common-word vocabulary
is bounded at 1,024 words, with at most 4,096 selected descriptors in the root;
remote pair-dictionary lookup is not implemented yet.
The document executor can intersect mandatory pairs from one phrase, reject
nonmatches using context, and omit word-position decoding for phrases entirely
covered by the pair evidence. Several contexts can jointly cover a longer phrase.
Missing pairs and uncovered neighborhoods remain unknown. The evidence callback
also preserves Boolean negation and proximity span composition. Exhaustive tests
exercise this integration and native construction; corpus-scale live pair
measurements are still outstanding. The earlier CWP1 experiment does not establish
those requirements at 1M or 10M.

### Earlier block-layout control

CWS1 has one corpus-wide term dictionary. The bundled root contains statistics,
the 256 highest-DF term roots, dictionary fences, document locator directory,
and object manifests. Dictionary fences themselves form a 256-way hierarchy,
with at most 256 bundled fences. Term descriptors occupy 256-entry leaf pages. Each term has a 64-way tree of document ranges and conservative body/title
score maxima. No common-term lookup constructs a whole-corpus flat plan.

Immutable objects are at most 64 MiB, with 256 KiB physical pages. Independent
physical lanes hold scores, positions, locators, and plans. Scoring leaves contain
at most 128 postings. Document IDs, frequencies, and positions use restartable
block-packed integers with explicit counts, bases, widths, and delta flags;
constant streams need no payload bits. Short tails use the same bounded header.
Body and title contributions remain float64, using the existing BM25 formula.

Each scoring leaf has independently addressed position and locator streams.
Positions have a per-row offset directory. Locators contain direct references to
the result record, forward directory, and first relevant passage. Display IDs,
metadata, and address arrays are absent from scoring loops. Result records and
passage text use gzip; posting execution uses no general-purpose decompression.
The Worker builder stores locators once in 4,096-document tables and leaves the
posting locator column empty. Surviving document handles address those tables
directly, avoiding repeated locator storage without a remote discovery step.

Forward body blocks contain numeric token IDs, 256 core tokens, and 32 tokens of
overlap on each side. Token IDs and display text have separate references.
The root also supports direct document lookup for complement-only queries.

## Execution and exactness

The existing Unicode tokenizer, parser, simplifier, positive-score term order,
field rules, positional semantics, and deterministic score/doc-ID ordering apply.
Typed numeric columns cover a 4096-document execution band. Mandatory selective
terms lead candidate selection. The anchor tree streams in bounded batches.
Broad queries use conservative range/block bounds, 128-document bound cells,
numeric intersection, and partial-score MAXSCORE rejection. Bounds are rounded
outward; tied scores cannot be discarded if the document tie could win. An
unfilled heap supplies no pruning threshold. Search-after uses the same score
and document ordering as the complete execution.

A compiled three-valued Boolean predicate distinguishes false, true, and unknown
positional conditions. Negated phrases remain unknown until verified. Competitive
position blocks are fetched in batches, independently of scoring data. The shared
positional evaluator accepts direct typed position arrays; its ordinary legacy
resource limits are unchanged, while the replacement supplies larger bounded
scratch limits. Resource exhaustion is an explicit error, never partial results.

CWP1 adjacent-pair postings are selected from corpus DF and occurrence counts,
using estimated rejected work per byte. Selection never reads benchmark queries.
Only selected pairs imply absence; an unindexed pair means unknown. A selective
pair can lead mandatory phrases. Pair strategies have a 65,536-document buffer
budget; larger cases use the complete buffered positional path. Sparse root
phrases verify numeric forward neighborhoods, with title evidence falling back
to positional verification. Broad and nested expressions use buffered positions.
Snippet selection uses exact matching spans where available, then retrieves the
corresponding passage. Complex-span scratch exhaustion falls back to a relevant
term passage after matching has succeeded.

CWH1 optionally bundles complete top-100 certificates for corpus-selected hot
terms and exact field/boost configurations. The initial selection is the 64
highest-DF terms, with body and all/title boosts 0, 2, and 20. Scores and document
handles are numeric; compressed display records are separate. Other boosts,
larger requests, exact totals, and every cursor use the ordinary executor. These
certificates are exact precomputation, not candidate truncation or response
caching. The current 100k certificates occupy about 7.17 MB before Worker bundle compression;
the 1M certificates occupy about 6.07 MB. Their startup and retained-memory costs
remain part of the serving budget.

## Memory, caching, and I/O

The hierarchy is bundled roots/selected hot data → bounded isolate memory →
validated immutable-page Cache API entries → R2. Page memory is capped at 24 MiB;
decoded memory at 4 MiB, including estimated key/object overhead. Decoded scoring
blocks own compact buffers so that small DataViews cannot pin evicted physical
pages. Cached decoded blocks are checked before reading their source page.
Text caches charge expanded strings/objects separately from compressed pages.

R2 pages are checked against generation identity and a page CRC before caching.
Small generations can bundle CRC directories; large roots carry a content-addressed
object key and SHA-256, while the same R2 range response supplies its CRC directory
as object metadata. This avoids an additional remote discovery stage.
Shared pages carry a generation-scoped validation receipt and are trusted like
validated memory on reuse. Rechecking every shared hit with a JavaScript CRC was
a measured CPU bottleneck. Namespace identities permit genuinely fresh shared
application pages without claiming control of R2 backend caches.

Outstanding read promises and the six-slot I/O semaphore belong to the request
context. Cross-request promise queues produced workerd unresolved-promise errors
and were removed. Validated bytes can be reused across requests. Admission allows
two simultaneous searches per isolate; excess work receives a measured 503 with
Retry-After. There is no hidden unbounded queue or assumed CPU fanout. Prefetching
is bounded by the request I/O semaphore and numeric execution batches.

Diagnostics separate postings/position integers, candidates, R2 bytes/requests,
shared-cache operations, memory hits, repeated decoding/inflation, metadata time,
and buffer/cache charges. `stages` counts explicit execution batches; it is not yet
a complete critical-path dependency graph. Inspector heap/backing-store samples
and allocation samples are separate diagnostics, not native peak-memory proof.

## Construction and publication

`columnar:build` is a TypeScript streaming adapter to the native Rust builder.
It accepts JSONL, gzip JSONL, standard input, or multiple source partitions.
Bounded ingestion batches write numeric sorted runs, forward token IDs, and
compressed display frames. A bounded-fan-in external merge assigns corpus-wide
UTF-16 lexical term IDs and computes global document frequencies and float64 BM25
contributions. Internal document IDs retain source order. Every run and completed
object has a checksum; completed generations publish atomically.

The native scorer implements the same formula using float64. Rust libm and V8
can differ in the last bits; the user authorized approximate FP equality, and
cross-runtime checks use relative tolerance 1e-11. Each engine uses its own exact
returned score for pagination. No quantization or approximate candidate cap is
used. Unicode 17 normalization, lowercase and word categories are checked against
V8. Unpaired UTF-16 JSON strings remain intact in IDs, metadata and display data;
only tokenization uses non-word replacement boundaries. Previews preserve exact
JavaScript UTF-16 slicing, including a cut inside a surrogate pair.

Local construction reclaims consumed numeric runs and staging objects. The remote
mode spills 64 MiB checksummed chunks to authenticated R2 transport, with two
concurrent uploads and backpressure. Final serving objects are independently
content addressed; build-scoped temporary chunks have a deletion ledger. R2
validates the supplied SHA-256 before acknowledging storage. Root publication
follows successful immutable publication, never the reverse. A dedicated cleanup
command removes only temporary stream keys, preserving serving objects.

The TypeScript Worker builder reads archived source documents directly from R2.
A local coordinator schedules HTTP requests; it never receives posting or text
bulk data. One deployed builder handles concurrent HTTP invocations across
isolates. Within an isolate, a bounded queue serializes requests before parsing
their bodies to avoid multiplying construction buffers. Ingestion and multiple
balanced merge levels run as independent jobs. Lexical ranges cross document
groups before the final merge, avoiding nearly serial full-corpus merge passes.
Posting jobs receive term
boundaries and global lexical IDs. Up to four input reads and two immutable output
writes overlap. Continuations retain numeric cursors, not entire streams.

Each producer owns a disjoint range of logical object IDs. The root stores a
sorted ID column alongside dense object descriptors, so independent jobs never
rewrite references or create enormous sparse arrays. Bounded hierarchy merges
combine disjoint dictionary ranges. Document jobs cover aligned 4,096-document
ranges. Separate jobs resolve the unique vocabulary of at most 1,024 documents
in lexical order, using an ID-only object directory. Document output reads these
small immutable maps instead of repeatedly traversing the global dictionary.
Display fields and forward blocks remain separately accessible.

Build output records code and source IDs, and the completed layout identifies its
immutable generation. Retries reuse completed R2 tasks. Accelerator builders read
the published numeric format with bounded caching. Deployment verifies immutable
objects before publishing the matching serving root.
Verification runs in 256-object jobs. Final publication checks their ordered
coverage and generation receipts, keeping each request below its subrequest
budget even when the complete generation contains many thousands of objects.

The direct 1M build and independent exhaustive oracle have completed. Live 1M
publication and largest-snapshot construction are in progress. A 1,000-document
remote-spill pilot passed 96 complete live field/query checks and temporary
cleanup. Larger builds are not validated by that pilot alone.

## Rejected approaches

- Retaining the old object-heavy pointer/row decoder in the execution loop.
- Small gzip frames and Response/DecompressionStream copies for postings.
- Flat common-term plans and score-cell traversal that repeatedly visits pages.
- Eager positions, display-object construction per posting, lossy score storage,
  common-word removal, or approximate top-K truncation.
- Cross-request fetch promises in serving Worker memory.
- Native synchronous gzip decoding: a live 500-request-per-variant comparison
  regressed P50/P95/P99 despite a favorable local microbenchmark.
- Hot-certificate band ordering for compound queries: a live ablation showed no
  convincing complete-response benefit and higher median sampled CPU. The normal
  path retains document-order traversal.
- Treating a memory reset request as a new isolate, or local CPU samples as proof
  of deployed CPU savings.

Cloudflare's current documented limits include 128 MB memory, six simultaneous
outgoing connections, and 64 MiB uncompressed Worker size. See the official
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[placement configuration](https://developers.cloudflare.com/workers/configuration/placement/).
