# work-search

Exact Boolean, phrase, proximity, and ranked search for Cloudflare Workers and R2.
The replacement execution engine is in `src/columnar`. It uses independently
addressed numeric streams, bundled metadata for up to one million high-frequency
terms, and direct R2 dictionary shards for the remaining vocabulary. Complete term
packets and anchor/document packages are the primary paths; hierarchical
block-max pruning handles larger queries. Metadata and query-relevant
snippets are included in complete responses. New builds apply English Porter2
stemming to both index and query tokens after NFKC normalization and lowercasing.
Common words remain indexed, including in phrases and proximity expressions;
display text and snippet offsets retain the original word forms.
No Containers, Durable Objects,
external serving database, or external search service is required.

Read the [format and execution design](bench/COLUMNAR-DESIGN.md) and
[live benchmark ledger](bench/COLUMNAR-BENCHMARK.md). Full-corpus adoption is still
gated on the outstanding scale and benchmark results. The existing public demo
has not been changed during comparisons.

## Build and search

Node 26.7 and Yarn drive the TypeScript constructor on Cloudflare Workers.
Sorting runs, postings, document packages and serving objects stay in R2; the
local coordinator stores metadata and progress. Input records contain `id`,
`body`, and optional `title` and `metadata` fields. The available corpus is already
archived in R2.

```sh
yarn install --frozen-lockfile
yarn node --import tsx scripts/construction-source.ts work/full-flp/published.json
yarn columnar:deploy:builder
CWS_BUILD_CONCURRENCY=32 yarn build-index 1000000 work/cws-1m corpus-1m
yarn node --import tsx scripts/build-pairs-in-workers.ts work/cws-1m work/cws-paired pairs-1m 1024
yarn deploy work/cws-paired work-search-cws-example --deploy-only
```

The optional accelerators are selected from corpus statistics. Missing
accelerator data always falls back to complete exact verification. The default
`build-index`, `columnar:build` and `columnar:build:r2` commands all use the same
constructor, taking document count, output directory and build ID.

```sh
CWS_REMOTE_URL=https://work-search-cws-upload.phulin.workers.dev yarn search-local work/cws-paired '"search engine"'
CWS_REMOTE_URL=https://work-search-cws-upload.phulin.workers.dev yarn dev work/cws-paired
```

`dev` runs workerd at `http://127.0.0.1:8787/search?q=court`; the CLI returns
complete results and counters. These are local diagnostics, not live latency
measurements. Their validated package-group reads may fetch more bytes than the
production range-read path. Without `CWS_REMOTE_URL`, objects must be available
locally. The older Rust 1.93 builder is retained under
`bench/columnar/control` for frozen controls and independent fixtures;
`yarn bench:columnar:build-offline` is its explicit diagnostic entry point.

For format and planner iteration, keep the 1M corpus and replay search locally
with simulated R2/cache delays. Data preparation downloads immutable bytes once,
outside the timed runs. Subsequent runs disable network access and use exact
range reads from disk; matching, ranking, metadata, snippets and JSON serialization
are included. Each compared plan has independent application and shared caches.

```sh
yarn node --import tsx bench/columnar/verify-corpus.ts work/columnar-corpus-1m.jsonl.gz
# Optional: retain every serving object locally, rather than only queried ranges.
yarn node --import tsx bench/columnar/mirror-index.ts work/cws-1m
# Regroup bundled metadata without rebuilding postings or deploying.
yarn node --import tsx bench/columnar/repack-directory.ts work/cws-1m work/cws-1m-g256 256
# Prepare the query data once, then iterate without deployments or credentials.
yarn node --import tsx bench/columnar/simulate.ts work/cws-1m work/oracle-1m.json --prepare-only
CWS_R2_MS=20 CWS_SHARED_MS=2 CWS_REPEATS=3 yarn node --import tsx bench/columnar/simulate.ts work/cws-1m work/oracle-1m.json
```

`CWS_PLANS` selects `auto,complete-terms,documents,blocks`. A forced plan that
exceeds its exact execution budget reports unsupported. `CWS_CONDITION` selects
`memory-reuse`, `shared-warm-memory-empty`, or `fresh-namespace`. Transfer rates
are configurable with `CWS_R2_MIBPS` and `CWS_SHARED_MIBPS`; defaults are 100 and
1,000 MiB/s, with fixed delays of 20 and 2 ms. These are explicit model inputs,
not measured Cloudflare defaults. `CWS_R2_JITTER_MS` adds uniform nonnegative
jitter. Reads overlap through the engine's ordinary six-slot scheduler, so
dependent phases and coalesced transfers retain their actual execution shape.
Results record local process CPU separately from simulated wall time. Live
Workers remain the final validation for successful changes.

Repeating the build command resumes completed R2 tasks. Use a new build ID and
output directory after changing construction code or source. Source generations
and checksums prevent mixed inputs; the completed layout determines the serving
generation and cache identity. The frozen benchmark control remains separate.
Ingestion, intermediate merges, final term ranges, posting construction, and
128-document package ranges run as independent jobs. Intermediate merges use
multiple balanced levels; the final term dictionary remains corpus-wide.
One builder Worker handles concurrent invocations; `CWS_BUILD_CONCURRENCY` controls
the number of outstanding requests, up to 128. Busy requests retry within that
bounded window. Cloudflare may distribute invocations across
isolates. A bounded queue serializes construction buffers within each
isolate. Each job uses bounded buffers and overlapping R2 I/O.

The native pipeline emits the common-term directory, compact cold-shard routing,
complete term packets and self-contained document packages. Cold shards colocate
small complete frequency and positional packets with their metadata. Selecting
the common tier uses document frequency and deterministic numeric-ID ties, with
no query-workload input. To convert existing native sorted output
without repeating ingestion and merges:

```sh
yarn node --import tsx scripts/build-packets-in-workers.ts work/old-native-build work/new-packets packets-v1
```

Corpus-selected positional pairs are constructed from grouped numeric document
tokens, with bounded four-way merge levels. Large occurrence merges divide into
independent pair-key ranges, retaining restart fences in their chunk descriptors.
This preserves parallel work at the final merge level:

```sh
yarn node --import tsx scripts/build-pairs-in-workers.ts work/new-packets work/new-paired pairs-v1
yarn deploy work/new-paired work-search-cws-r2-1m --deploy-only
```

The pair pass counts observed adjacent combinations of up to 65,536 high-DF words
using sorted sparse numeric runs, and chooses at most 65,536 positional/context
packets from corpus statistics. Global statistics merge through bounded 512 KiB
chunks rather than a vocabulary-squared table.
Pairs outside that vocabulary remain unknown and use exact ordinary verification.
The remote pair dictionary keeps most descriptors and small complete packets in
R2, with 256 selected descriptors bundled. Expanded coverage has not yet shown
a live latency benefit.

Check account script count, resource errors, CPU/memory analytics and R2 operations
occasionally during large builds:

```sh
yarn node --import tsx scripts/cloudflare-usage.ts 1
```

The output includes account/bucket activity from other work. Invocation memory
percentiles are separate from peak or retained memory, and paid-plan usage
allowances are billing thresholds rather than hard request limits.

Build results record source checksums and construction code. Temporary R2 runs
are reclaimed after they are no longer needed by active jobs or validation.
Construction does not depend on a CI service or local index-sized storage.

## Isolated deployment and comparison

Existing Wrangler authentication is used. Benchmark deployments require names
beginning `work-search-cws-` and use a separately generated benchmark token.
They do not modify the public demo. Deployment snapshots runtime source and roots,
verifies immutable objects, publishes to R2, and records provenance manifests.

```sh
yarn deploy indexes/cws work-search-cws-example
yarn node --import tsx bench/columnar/freeze-control.ts
yarn node --import tsx bench/columnar/deploy-control.ts
CWS_VARIANTS=work-search-cws-control,work-search-cws-example \
  CWS_LABEL=comparison yarn bench:columnar
```

`bench/columnar/live.ts` runs randomized interleaved correctness pilots.
`load.ts` adds controlled arrival rates, client queueing, repeated sessions,
held-out contracts, and error/rejection accounting. `with-tail.ts` joins sanitized
native CPU/wall observations by request ID without retaining request headers.
`report.ts` writes raw compressed results, class-level summaries, and uncertainty
to `bench/results/columnar`.

```sh
CWS_DRIVER=bench/columnar/load.ts CWS_VARIANTS=work-search-cws-control,work-search-cws-example \
  CWS_LABEL=final CWS_REQUESTS=10000 CWS_RATE=4 CWS_SESSIONS=3 \
  CWS_CONDITION=memory-reuse yarn bench:columnar
yarn node --import tsx bench/columnar/report.ts final
```

In-request `resetMemory` empties application caches in the executing request.
Fresh shared-cache namespaces and actual deployment startup are separate cases.
No harness claims control over opaque R2 backend caches. Placed benchmark clients
are available through `deploy-regions.ts`; report their data-center client latency
separately from local client latency.

The large-corpus extraction, compression, streaming immutable upload, independent
exhaustive oracle, local CPU/allocation/memory profiles, and native profile capture
tools are in `scripts/columnar-*` and `bench/columnar`. Generated corpora, sort
databases, runtime snapshots, and credentials remain under ignored `work/` paths.

Independent source validation can also run in parallel on the constructor Worker,
without downloading corpus text to the coordinator. It tokenizes archived source,
uses an independent exhaustive AST evaluator, merges exact range top-K results,
and verifies query DFs and global field statistics:

```sh
yarn node --import tsx bench/columnar/deploy-oracle.ts
CWS_ORACLE_WORKERS=32 yarn node --import tsx bench/columnar/oracle-in-workers.ts work/new-paired regression work/oracle.json
```

The current deployment helper preserves running constructor handlers during the
full-corpus migration. The validator resumes local receipts after interruption.
Pass a JSON array of query contracts instead of `regression` for held-out cases.

## Validation and historical controls

```sh
yarn run check
yarn builder:check
yarn test
```

Tests cover packed-format corruption, independent exhaustive matching/ranking,
Unicode, nested Boolean and negative positional expressions, repeated terms,
long documents, field boosts, deterministic ties, pagination, generation
consistency, real workerd R2/shared-cache execution, and concurrent admission.

Historical codecs and global-engine tests remain as regression oracles and
benchmark controls while adoption is evaluated. The old serving formats are not
accepted by the replacement. Historical commands and architecture are preserved
in the Git history and the existing `bench` reports; new build/search/dev/deploy
commands use the replacement engine.

## Filtered replacement serving

The replacement supports generic typed metadata filters before top-K selection,
including exact totals and filtered search-after. Use `yarn columnar:metadata` to
build aligned metadata columns, then `yarn prepare-deploy` to generate a complete
Worker entry and configuration locally. Pass `--membership DIR --metadata DIR`
to preparation, bundling and deployment so the complete-pair planner and metadata
filter source are included. Direct API consumers can instead supply a batched
`Options.documentFilter` provider over their existing internal-ID-aligned data.

See [metadata filters and deployment](bench/METADATA-FILTERS.md) for the request
contract, commands, 1M validation results, publication checks and remaining
Casework/full-corpus integration work. Preparation does not deploy or upload.
