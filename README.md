# work-search

Exact Boolean, phrase, proximity, and ranked search for Cloudflare Workers and R2.
The replacement execution engine is in `src/columnar`. It uses independently
addressed numeric streams and a complete bundled term directory. Complete term
packets and anchor/document packages are the primary paths; hierarchical
block-max pruning handles larger queries. Metadata and query-relevant
snippets are included in complete responses. No Containers, Durable Objects,
external serving database, or external search service is required.

Read the [format and execution design](bench/COLUMNAR-DESIGN.md) and
[live benchmark ledger](bench/COLUMNAR-BENCHMARK.md). Full-corpus adoption is still
gated on the outstanding scale and benchmark results. The existing public demo
has not been changed during comparisons.

## Build and search

Node 26.7, Yarn, and Rust 1.93 are required for matching Unicode 17 behavior.
The TypeScript commands stream into the native external-sort builder. SQLite is
used only when constructing optional positional accelerators. Input records contain
`id`, `body`, and optional `title` and `metadata` fields.

```sh
yarn install --frozen-lockfile
yarn generate-sample
yarn build-index data/sample.jsonl indexes/cws
yarn columnar:pairs indexes/cws
yarn columnar:heads indexes/cws
yarn search-local indexes/cws '"search engine"'
yarn search-local indexes/cws 'alpha OR beta' '{"field":"title","titleBoost":3.25}'
yarn dev indexes/cws
```

`dev` runs the actual workerd execution path with local file-backed object reads
at `http://127.0.0.1:8787/search?q=court`. Local diagnostics are not substitutes
for live Worker measurements. The Node CLI returns results and work counters.

`columnar:build` also accepts comma-separated source partitions, gzip JSONL,
and an optional maximum document count. Construction does not pass through a
legacy bundled index. The optional accelerators are selected from corpus
statistics. Missing accelerator data always falls back to the complete executor.

```sh
yarn columnar:build corpus.jsonl.gz work/cws-1m 1000000
yarn columnar:pairs work/cws-1m
yarn columnar:heads work/cws-1m
```

Accelerators read the published format independently of builder staging files.
For the already published R2 corpus, construction can run entirely in Workers.
The local TypeScript process schedules requests and stores small checkpoints;
postings, sorting runs, passage text and serving objects stay in R2.

```sh
yarn node --import tsx scripts/construction-source.ts work/full-flp/published.json
yarn columnar:deploy:builder
CWS_BUILD_CONCURRENCY=32 yarn columnar:build:r2 1000000 work/cws-r2-1m corpus-1m
yarn deploy work/cws-r2-1m work-search-cws-r2-1m --deploy-only
```

Repeating the build command resumes completed R2 tasks. Use a new build ID and
output directory after changing construction code or source. Source generations
and checksums prevent mixed inputs; the completed layout determines the serving
generation and cache identity. The frozen benchmark control remains separate.
Ingestion, intermediate merges, final term ranges, posting construction, and
128-document package ranges run as independent jobs. Intermediate merges use
multiple balanced levels; the final term dictionary remains corpus-wide.
One builder Worker handles concurrent invocations; `CWS_BUILD_CONCURRENCY` controls
the number of outstanding requests, up to 128. The packet coordinator reduces
its window when admission is busy. Cloudflare may distribute invocations across
isolates. A bounded queue serializes construction buffers within each
isolate. Each job uses bounded buffers and overlapping R2 I/O.

The native pipeline now emits the full bundled directory, complete term packets
and self-contained document packages. To convert existing native sorted output
without repeating ingestion and merges:

```sh
yarn node --import tsx scripts/build-packets-in-workers.ts work/old-native-build work/new-packets packets-v1
```

Corpus-selected positional pairs are constructed from grouped numeric document
tokens, with bounded four-way merge levels:

```sh
yarn node --import tsx scripts/build-pairs-in-workers.ts work/new-packets work/new-paired pairs-v1
yarn deploy work/new-paired work-search-cws-r2-1m --deploy-only
```

This initial pair pass counts all adjacent combinations of 1,024 high-DF words
and chooses at most 4,096 positional/context packets from corpus statistics.
Pairs outside that vocabulary remain unknown and use exact ordinary verification.
Full pair-vocabulary coverage and a remote pair dictionary remain outstanding.

Check account script count, resource errors, CPU/memory analytics and R2 operations
occasionally during large builds:

```sh
yarn node --import tsx scripts/cloudflare-usage.ts 1
```

The output includes account/bucket activity from other work. Invocation memory
percentiles are separate from peak or retained memory, and paid-plan usage
allowances are billing thresholds rather than hard request limits.

The default builder reclaims consumed staging data. For corpora larger than local
disk, set `CWS_OFFLINE_STORE` to the authenticated uploader; construction spills
checksummed temporary streams to R2 with bounded upload backpressure. Build results
record the source checksum and builder version; construction does not depend on a CI service.

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
