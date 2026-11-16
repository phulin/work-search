# Architecture

The default commands in `package.json` build and serve the columnar engine in
`src/columnar`. The system has three parts: immutable search data in R2,
TypeScript constructor Workers, and a query Worker. A local coordinator schedules
construction and persists checkpoints; corpus-sized intermediate data stays in R2.

## Source and construction

`scripts/construction-source.ts` prepares archived source descriptors.
`src/columnar/construction/source.ts` reads source records by checked ranges.
Text analysis in `src/query/analysis.ts` normalizes Unicode with NFKC, lowercases,
and, for `nfkc-lower-porter2-v1` generations, applies English Porter2 stemming.
Ingestion and queries use the generation's same analysis. Common words retain
positions; display text retains its original spelling.

`scripts/build-fresh-in-workers.ts` coordinates
`src/columnar/construction/fresh-worker.ts`. Ingestion, bounded sorted runs,
merge levels, vocabulary assignment, posting ranges, and document groups are
independent jobs. Task receipts and source identities make retries resumable.
Publication checks ordered coverage and immutable object identities before
exposing a completed root. `scripts/build-packets-in-workers.ts` and
`scripts/build-pairs-in-workers.ts` add packet directories and pair data to
existing construction output.

`crates/index-builder` supplies the native offline builder. Its build script
uses Node to generate Unicode tables compatible with the JavaScript tokenizer.
The native command and benchmark fixture builders remain available separately
from the default Worker constructor.

## Immutable storage

A root identifies a generation, corpus statistics, term dictionaries, object
inventory, and optional document, pair, and metadata directories. References
address a logical object, byte offset, and byte length. Object digests, range
checksums, and generation checks bind fetched bytes to the active index.

The bundled term directory holds common-term descriptors and routes other terms
to R2 shards. Frequency/score packets and positional streams have independent
addresses. Large postings retain a block hierarchy. Document records keep
numeric verification separate from compressed metadata and text passages;
a bundled document directory gives direct record addresses. Pair membership and
complete context provide additional exact sources for short phrases. See
[storage formats](FORMAT.md) for the corresponding modules.

## Query execution

`src/columnar/worker.ts` implements the HTTP boundary. It parses options,
constructs generation-bound readers, admits at most two searches per isolate,
and calls `ColumnarIndex` in `search.ts`. Query parsing and AST simplification
are shared with the other engines in `src/query`.

The planner chooses among complete term packets, selective anchor memberships
followed by document verification, and hierarchical block retrieval. It prices
bytes, dependent reads, decoding, and candidate verification. Continuation
planning can use actual candidate counts and physical ranges after initial I/O.
A strategy budget changes execution paths; it never truncates the candidate set.

Complete pair memberships conservatively restrict candidates. Pair context can
prove covered phrases of up to four tokens; other expressions use ordinary exact
positions. [Document verification](COLUMNAR-VERIFICATION.md) and
[complete phrase execution](EXACT-PHRASES.md) describe these paths.

The block path uses conservative MAXSCORE bounds, batched numeric scoring, and
bounded positional lookahead. Only fully verified matches raise the top-K
threshold. Ranking uses the distinct positive query terms, BM25 body/title
contributions, field boosts, and deterministic document-order ties. Optional
metadata filters apply before top-K. Search-after cursors are tied to the search
generation. Exact totals require complete matching coverage.

Winners fetch display metadata and relevant compressed passages after matching
and ranking. Rejected candidates do not fetch presentation text. Query-language
semantics are documented in [QUERY.md](QUERY.md).

## Memory and I/O

`storage.ts` owns the `Reader`, byte-accounted LRUs, and I/O semaphore.
`r2.ts` provides range-backed R2 access. The hierarchy is bundled metadata,
bounded isolate memory, validated Cache API pages, then R2. Cache identities
include the generation. Requests share validated immutable bytes; pending-read
promises and the six-slot I/O scheduler belong to each reader.

Nearby physical ranges can coalesce, while cached pages own their backing
buffers. Packet deployments use a 12 MiB raw page/package cache, a 4 MiB decoded
cache, and a separate 2 MiB decoded term-directory cache. Active queries and
bundled data consume additional memory. Rolling execution buffers are bounded
independently of cumulative transfer. Resource exhaustion is an explicit error,
never a partial result presented as complete.

## Local serving and publication

`scripts/search-columnar.ts` uses `OfflineObjects` or the prepared local object
store. `scripts/dev-columnar.ts` runs the Worker in Miniflare and serves local
immutable ranges. `scripts/columnar-serving.ts` loads and validates the selected
base, membership, and metadata assets and generates a deployable entry.

`scripts/deploy-columnar.ts` verifies and publishes immutable objects before
Wrangler deployment. Upload journals allow resumption; `--deploy-only` verifies
existing published data. The root and bundled directories must match their
immutable object generations.

## Other implemented engines and tools

`src/global` implements the global paged engine and its CLI. `src/builder`,
`src/format`, `src/query/engine.ts`, and `src/worker` implement the earlier bundled
and paged formats. `demo/gateway-runtime.ts` routes queries to shard Workers;
`demo/shard-runtime.ts` runs shard search and presentation. Their entry points
still consume the binaries in `data/`, which remain runtime inputs.

These engines share query semantics and serve as regression references.
`bench/` includes reusable drivers, local I/O models, exhaustive evaluators,
profilers, and source-level reference implementations used by tests. Generated
measurements and frozen source archives are not part of the committed source.
