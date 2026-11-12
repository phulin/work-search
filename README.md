# Worker Bundle Search

A standalone TypeScript full-text search engine. The bundled layout keeps the binary dictionary, document tables and selected postings in the Worker. The paged layout keeps a compact routing root and selected hot data locally, with cold dictionary pages and postings in immutable R2 objects accessed by byte range. Serving uses Workers and R2, with no external database, framework or search service.

## Run locally

Requires Node **22.13+** (24+ recommended), npm, and enough temporary disk for external-sort runs. Node's built-in SQLite is used only by the offline builder to detect duplicate IDs on disk.

```sh
npm ci
npm run generate-sample
npm run build-index -- --input data/sample.jsonl
npm run search-local -- --query 'search engine'
npm run check
npm test
npm run dev
# In another terminal:
curl 'http://localhost:8787/search?q=search+engine&limit=20'
curl 'http://localhost:8787/health'
```

`dev` first seeds Wrangler's persistent local R2 with the selected generation, including the generation metadata checked by the storage adapter. The checked-in sample binary supports `npm test` and dry runs immediately. It contains 100 deterministic synthetic documents; `generate-sample` recreates its JSONL source. Local indexing needs no Cloudflare account.

## Input and indexing

JSONL documents require a nonempty string `id` and string `body`; `title` and arbitrary JSON `metadata` are optional. Blank lines are skipped. Empty corpora and empty bodies are valid. Malformed JSON, invalid fields, and duplicate external IDs fail with a line number. Internal IDs are zero-based input order and remain stable across budgets and spill sizes for the same ordered corpus. Updating/reordering a corpus creates a new generation.

```sh
npm run build-index -- --input corpus.jsonl --out indexes/basic-v5 --budget-mib 16
npm run build-index -- --input corpus.jsonl --out indexes/terms-v5 --budget-mib 8 \
  --strategy workload --workload queries.txt --chunk-docs 5000
npm run search-local -- --out indexes/terms-v5 --query 'example text' --mode or --metadata
npx tsx src/cli/main.ts verify --out indexes/terms-v5
```

The current binary format is **v5** and rejects v1/v2/v3/v4 indexes. Rebuild into a fresh directory (for example `--out indexes/terms-v5`) before running `dev`, local search, or deployment with an existing checkout. A complete corpus rebuild is required to add independently readable posting blocks; there is no in-place migration from older indexes. After rebuilding, use `npm run dev -- --out indexes/terms-v5` and `npm run search-local -- --out indexes/terms-v5 --query "search"` to select that directory.

Use a fresh output directory for each build. A generation's objects are never overwritten by the builder. `queries.txt` contains one query per line; repeated lines supply frequencies. The bundle budget includes dictionary, document tables, IDs, and embedded postings. A budget too small for mandatory tables is rejected. `build-index` selects the resulting binary for the next Worker build by copying it to `data/bundle.bin`.

Frequency and position streams have independent locations and CRCs. Frequencies receive embedding priority; positions can use remaining space. Plain Boolean queries never read positional payloads; mixed queries fetch positions only for location-dependent terms. Diagnostics report `frequencyRequests`/`frequencyBytes` and `positionRequests`/`positionBytes` separately, with their sum in the existing index totals. A positional query may need more R2 requests than with the previous interleaved format.

The builder streams documents, spills term-sorted runs, merges at most 32 streams per pass, compresses one merged term at a time, and packs remote objects up to 64 MiB (an individual larger posting stays contiguous). IDs are checked in an on-disk SQLite uniqueness table. RAM scales with the document table, vocabulary, one input chunk, largest term list, and final bundle—not the entire corpus postings. Title/body text and metadata are not retained in memory. A single very large input document or dominant term can still consume substantial builder RAM.

## Search API

```text
GET /search?q=example+text&limit=20
GET /search?q=example+text&mode=or&field=title&titleBoost=3
GET /search?q=example&metadata=true
GET /search?q=example&total=true
GET /health
```

Default implicit AND; optional implicit OR. Explicit Boolean grouping, NOT, quoted phrases and proximity are supported: `(red OR blue) AND "fox jumps"`, `red /5 fox`, `red /s fox` (25 tokens), and `red /p fox` (75 tokens). See [query language](docs/QUERY.md) for Lexis-style precedence, exact matching rules and limits. NFKC Unicode normalization, lowercase, and Unicode letter/number tokenization. No stemming, stop-word removal, or language-specific word segmentation. Tokens with no separator (for example a CJK sentence) form one token. Distinct terms score once; repeated tokens inside phrases remain significant. Empty queries return no matches; AND queries containing missing terms return immediately without reads. `field` is `all`, `title`, or `body`; `titleBoost` defaults to 2 (0–20); `limit` defaults to 20 (1–100). Queries allow at most 16 distinct terms and 2,048 UTF-16 characters. Invalid requests return 400, unknown routes 404, storage/corruption failures 503.

Results contain external IDs and exact scores. The default `total=false` omits the match count and enables score pruning. Request `total=true` for an **exact** count of matching documents. Ties use internal input order. BM25 is computed separately for title/body lengths, using the union document frequency for each term, then summed with title boost. Field restrictions reuse that union DF. Metadata/title are fetched only with `metadata=true`; body text is not returned.

Enable `DIAGNOSTICS="true"` in Wrangler's vars, then request `diagnostics=true`. Production defaults to off. Diagnostics separate lookup, fetch/decode/checksum, scoring, index request/bytes, metadata request/bytes, and `fullyLocal`. Byte counts are requested payload bytes, not network/protocol overhead. Request counts are attempted adapter reads. Cache hits are reported separately and do not count as R2 reads. A fully embedded ID-only query makes zero R2 calls. Metadata uses one range per returned hit, with concurrency four. Metadata duration is included in total client latency but not index-fetch timing.

## Cloudflare deployment

Edit `wrangler.json` for your Worker and bucket names; create the bucket:

```sh
npx wrangler login
npx wrangler r2 bucket create worker-search-index
# Export variables shown in .env.example. R2 S3 credentials are separate from Wrangler auth.
# Build a new generation, then:
npm run deploy -- --out indexes/terms-v5 --bucket worker-search-index
```

`deploy` verifies the bundle and every object SHA-256 against the manifest; signs R2 S3 HEAD/PUT requests; skips already-present objects only if generation, checksum metadata, and length match; uses conditional creation for missing objects; selects the exact binary; then runs Wrangler deployment. Upload must complete before the Worker changes. Runtime R2 access uses **only the binding**, never S3 or public HTTP. S3 credentials stay on the build machine. `--bucket` must match the bucket binding in `wrangler.json`. The standalone S3-credential upload path has not been validated against an account. The [deployed demo](demo/README.md) uses Wrangler OAuth and a private Worker/R2-binding upload path, which has been exercised on Cloudflare.

```sh
npm run bundle  # actual Wrangler binary-module dry run and upload-size report
curl 'https://YOUR_WORKER.workers.dev/health' # confirm expected generation
curl 'https://YOUR_WORKER.workers.dev/search?q=example'
npx tsx bench/remote.ts https://YOUR_WORKER.workers.dev 'example' 'common rare'
```

A failed upload leaves the old Worker intact. A failed deployment may leave unreferenced immutable objects, which are safe to collect later. Runtime keys contain the bundle's generation; R2 object custom metadata must match it, and each posting has a bundle-resident CRC32. Never edit object contents or metadata manually. Roll back by deploying the old binary and retaining its objects.

**Garbage collection:** inventory all live deployments, gradual rollout versions, and rollback candidates; keep every referenced generation; after old requests and your rollback retention period expire, delete only unreferenced generation prefixes. There is deliberately no automatic destructive collector.

## Limits and tuning

Cloudflare's [current limits](https://developers.cloudflare.com/workers/platform/limits/) checked November 11, 2026 list 64 MiB **uncompressed** Worker size, 128 MiB isolate memory, and 1 second startup. The default 8 MiB index leaves room for code, per-isolate runtime, and decoding. Configurable budgets up to 48 MiB are experiments, not a universal memory guarantee. Always inspect `npm run bundle` and validate startup on your account. Format v4 retains the compressed bundled document table using 32-document restart blocks, bit-packed length deltas, front-coded IDs and metadata pointer deltas. The million-document synthetic corpus now fits all benchmark budgets; less compressible IDs or lengths may still require more space. See the before/after benchmark report.

Queries retrieve up to four remote ranges concurrently. A conservative working-set estimate rejects oversized queries rather than allocating unbounded typed arrays. Concurrent requests share an isolate and can still exhaust memory; large, common-term queries may exceed the Free plan's 10 ms CPU limit. Paid Workers are appropriate for that workload. New v8 builds execute positive Boolean term queries through block cursors with persisted score bounds; other default queries use block-max score pruning after decoding; explicit total=true queries score every matching candidate to compute exact counts. Adaptive v5 planning skips irrelevant posting blocks, and a bounded warm-isolate cache can retain complete postings, block directories, decoded blocks and small remote ranges. Suitable pure OR queries can use pivot WAND; small/cached mixed trees retain materialized execution. Metadata filters, root expansion/wildcards, automatic word variants, and incremental updates are not implemented. Position/phrase queries add storage and CPU costs; see [bench/SPLIT-POSTINGS.md](bench/SPLIT-POSTINGS.md).

## Benchmarks and layout

For the deployed multi-partition demo, use the [realistic end-to-end benchmark](bench/DEMO-REALISTIC.md).
It pins 2.87 million official-snapshot opinions across 67 production partitions,
includes case details, excerpts and pagination, and calibrates local simulation
with native Worker/R2 measurements. Earlier single-index, ID-only and fixed-delay
reports measure different paths.

```sh
npm run bench:demo -- --prepare # signed-in account: freeze, measure and mirror
npm run bench:demo             # rerun offline against the prepared mirror
```

The workload covers legal query scenarios; it is not sampled user traffic.

```sh
npm run bench  # 10k, 100k, 1m; 8/16/32/48 MiB; both strategies
npm run bench -- --reuse-indexes # query-only rerun of verified existing indexes with matching construction records
npm run bench -- --sizes 10000 --budgets 8,16
npm run bench -- --sizes 100000 --input /absolute/path/real.jsonl --queries queries.txt
npx tsx bench/runtime.ts  # startup and HTTP measurements in local workerd
npx tsx bench/bundle.ts   # dry-run the 48 MiB bundle, then restore sample binary
```

For supplied corpora, `--sizes` labels the corpus; the actual document count is also recorded in successful results. The runner creates a new child process per configuration and preserves failed/infeasible configurations. Generated corpora and indexes are ignored by Git. The execution optimization is documented in [bench/POSITIONAL-OPTIMIZATION.md](bench/POSITIONAL-OPTIMIZATION.md); that historical execution-only optimization retained v3 compatibility; the new v4 stream split requires rebuilding. The v4 format-change comparison is [bench/SPLIT-POSTINGS.md](bench/SPLIT-POSTINGS.md), with the optimized v3 baseline under `bench/baseline-v3-optimized/`. The historical positional-feature comparison is [bench/CONNECTORS.md](bench/CONNECTORS.md), with the optimized v2 baseline under `bench/baseline-v2-optimized/`. The historical v1 baseline is preserved under `bench/baseline-v1/`, and the original compressed-reader measurements under `bench/baseline-v2/`. [bench/OPTIMIZATION.md](bench/OPTIMIZATION.md) compares the reader optimization. Historical `bench/length-access.ts`, `bench/paired.ts` and `bench/optimization-report.ts` require v2-generated indexes; run them from the preceding v2 commit to reproduce that experiment. After those runs, `npx tsx bench/optimization-report.ts` regenerates the optimization comparison. The v4 runner regenerated SPLIT-POSTINGS.md after its matrix; historical `bench/compare.ts` is for the v1/v2 experiment; the report is [bench/COMPARISON.md](bench/COMPARISON.md).

Results are in [bench/RESOURCES.md](bench/RESOURCES.md), [bench/WORKERD.md](bench/WORKERD.md), [bench/REPORT.md](bench/REPORT.md), [bench/results/results.json](bench/results/results.json), and individual sample JSON files. Local filesystem/HTTP-handler times are separated from local workerd and deployed network measurements. Cost formulas and caveats are in the report.

```text
src/builder/   streaming construction, external merge, embedding selection
src/format/    versioned binary layout, varints, posting codecs, CRC32
src/query/     normalization, sorted intersection/union, BM25, bounded top-K
src/storage/   range-read abstraction, filesystem and R2 adapters
src/worker/    HTTP validation, health, binary module entry point
src/cli/       generator, build/search/verify/seed/deploy, signed R2 uploads
tests/         independent brute-force reference, unit/integration/workerd tests
bench/         matrix runner, raw measurements, reports, deployed-latency runner
data/          sample corpus and selected Worker binary
docs/          binary format and query-language specifications
```

See [DESIGN.md](DESIGN.md) for tradeoffs and the highest-value next optimizations.

Latest scoring-loop measurements: [benchmark report](bench/SCORING-OPTIMIZATION.md).

Block-based postings and skip planning: [benchmark report](bench/BLOCK-POSTINGS.md). Format v5 counts all block directories and embedded payloads against the same configured bundle budget.

The v5 decoder performance recovery is measured in [bench/BLOCK-DECODING.md](bench/BLOCK-DECODING.md); existing v5 generations can be served without rebuilding.

The four remaining optimization experiments are implemented and measured in [bench/REMAINING-OPTIMIZATIONS.md](bench/REMAINING-OPTIMIZATIONS.md). Build with `--strategy mixed --workload queries.txt` to allocate embedding space jointly to frequencies and positions. Existing v5 indexes remain compatible; adopting a different placement creates a new immutable generation.

Adaptive query planning is enabled by default. HTTP `total=false` is the default: exact top-K block-max score pruning omits the match count. Opt into exact totals with HTTP `total=true` or CLI `--total`; CLI `--no-total` remains supported for explicit count omission. The materialized path prunes after frequency decoding; eligible positive queries can instead use persisted block bounds, composable Boolean cursors, or pivot WAND. Runtime score-bound construction remains a cost on the materialized path; warm calls can reuse bounds.

The Worker retains up to `CACHE_MIB` MiB of complete verified decoded postings and score bounds (default 4, configurable 0–8; set 0 to disable). The cache is per warm isolate, scoped to immutable generations, and constrained by query memory headroom. Cache-cold queries and lists exceeding capacity still read/decode normally. Concurrent requests can still exhaust isolate memory even with a bounded cache.

Seven further optimizations and their cumulative measurements: [bench/NEXT-OPTIMIZATIONS.md](bench/NEXT-OPTIMIZATIONS.md). New builds write v8; the Worker also reads v5–v7 generations. [docs/FORMAT.md](docs/FORMAT.md) documents the extensions. Reproduction commands:

```sh
# Existing benchmark fixture indexes are required; generate them with npm run bench.
node --import tsx bench/next-prepare.ts
for stage in 0 1 2 3 4 5 6 7; do node --import tsx bench/next.ts "$stage"; done
node --import tsx bench/next-matrix.ts
node --import tsx bench/next-worker.ts
python3 bench/next-report.py
```

The new matrix converts existing immutable index streams offline, then reselects embedding within the original budgets. Conversion timings are not corpus-ingestion throughput. See the report for fixture preparation and cold/warm definitions.

A real-text Free Law Project/CourtListener sample is available through the
reproducible COLD Cases sampler:

```sh
uv venv work/flp-venv
uv pip install --python work/flp-venv/bin/python -r bench/flp-requirements.txt
work/flp-venv/bin/python bench/sample-flp.py
node --import tsx bench/flp-prepare.ts
node --import tsx bench/flp-build.ts
node --import tsx bench/flp-run.ts
node --import tsx bench/flp-worker.ts
python3 bench/flp-report.py
npm run search-local -- --out bench/generated/flp/8-mixed --query '"summary judgment"'
```

The sampler selects 10,000 untruncated decisions across all 32 source shards,
pins the dataset revision and seed, and records source row locations and corpus
SHA-256. Full texts and indexes stay in ignored generated files. The benchmark
uses disjoint embedding-training/evaluation strings, randomized paired execution
variants, and shuffled cache traffic. See [bench/FREE-LAW-PROJECT.md](bench/FREE-LAW-PROJECT.md)
for results, corpus distributions, sampling limitations, and local-runtime caveats.

Boolean execution now routes small/cached mixed trees to sorted-set operations,
uses composable block iterators for larger positive trees, and selects pivot WAND
for suitable OR queries. Existing index bytes and bundle/cache budgets stay the
same. [bench/BOOLEAN-WAND.md](bench/BOOLEAN-WAND.md) reports Boolean recovery first,
then WAND, including a separate OR evaluation set and forced-executor controls.
`total=true`, positional/negative queries and metadata requests retain the
materialized executor; default top-K results remain exact.

The same pinned legal corpus can be scaled without overwriting the 10k fixtures:

```sh
work/flp-venv/bin/python bench/sample-flp.py --count 100000 --out bench/generated/flp-100000
export FLP_ROOT=bench/generated/flp-100000
export FLP_PREFIX=flp100k
export FLP_QUERY_SOURCE=bench/results/flp-queries.json
node --import tsx bench/flp-prepare.ts
node --import tsx bench/flp-build.ts
node --import tsx bench/boolean-run.ts
node --import tsx bench/boolean-worker.ts
python3 bench/flp-scale-report.py
```

This preserves the original query strings and records infeasible budgets instead
of reducing the corpus or moving the dictionary remotely. Sampling uses hashed
shard checkpoints and shuffles file offsets rather than full texts in memory.
See [bench/FLP-100K.md](bench/FLP-100K.md) for the 100k run and comparisons.

### R2-backed paged layout

Use `npm run build-index -- --input corpus.jsonl --out indexes/paged --layout paged`
for a small bundled routing root with the complete dictionary, lengths, IDs and
postings stored in immutable R2 objects. The offline `.staging` sibling is an
intermediate and must not be deployed. It can be removed after verification.
The existing builder's document/term bookkeeping still consumes offline RAM.

To convert a completed index without tokenizing again:

```sh
node --import tsx src/cli/main.ts page --source indexes/current --out indexes/paged
npm run search-local -- --out indexes/paged --query '"summary judgment"'
node --import tsx src/cli/main.ts verify --out indexes/paged
npm run dev -- --out indexes/paged
npm run deploy -- --out indexes/paged
```

Both layouts use the same API and R2 upload/generation checks. The paged root
contains page boundaries, locations, checksums and corpus statistics; it does not
contain the full vocabulary. Missing terms can require dictionary reads. Resolving
external IDs can require reads even when postings are cached. Diagnostics include
`paged`, `dictionaryDocumentRequests` and `dictionaryDocumentBytes`; these page
reads are also included in aggregate `indexRequests`/`indexBytes` and `fullyLocal`.
Legacy phase durations do not separately isolate all paged I/O; use end-to-end
latency for comparisons. The per-isolate LRU remains bounded and query page views
are isolated between concurrent requests.

See [the 100k paged comparison](bench/PAGED-INDEX.md) for real local measurements
and per-read simulated R2 latency at 0, 5 and 20 ms. No Cloudflare deployment
latencies are claimed.

For faster paged searches on a corpus whose scoring lengths and ID mapping fit
in the budget, add `--local-tables`:

```sh
npm run build-index -- --input corpus.jsonl --out indexes/hybrid --layout paged --local-tables --budget-mib 8
# Or repack an existing bundled generation:
node --import tsx src/cli/main.ts page --source indexes/current --out indexes/hybrid --local-tables --budget-mib 8
```

This embeds exact body/title lengths and a separate compact external-ID table.
Dictionary pages, postings, positions and full metadata remain in R2. Metadata
requests still resolve remote document records; ID-only searches avoid those
reads. The builder rejects a bundle that exceeds the chosen budget. For larger
corpora, omit `--local-tables` to retain the fully paged document tables.

Hybrid roots use adaptive frequency reads by default: lists up to 256 KiB use
one read; larger streams combine the directory with initial data and grow
sequential read-ahead from 64 KiB up to 1 MiB. Library callers can set
`pagedReadPolicy: "fixed"` to compare the previous policy. The existing v1
paged layout keeps its fixed-read default.

The [hybrid benchmark report](bench/HYBRID-INDEX.md) measures each change, using
fixed per-read delays and a separate shared-bandwidth sensitivity run.

### Hot descriptors, embedded streams and inline dictionary postings

```sh
node --import tsx src/cli/main.ts page --source indexes/current --out indexes/optimized \
  --local-tables --hot-descriptors 10000 --embed-postings --inline-tiny \
  --workload queries.txt --budget-mib 8
npm run dev -- --out indexes/optimized
npm run deploy -- --out indexes/optimized
```

The same flags work with `build --layout paged`. Hot descriptors are ranked by
training-query frequency, then corpus document frequency. Remaining bundle space
is assigned by the existing query-completion stream selector. Unknown terms still
use the complete R2 dictionary. Cold dictionary pages can carry frequency and
position streams totaling at most 128 bytes for lists of at most 256 documents.
The total root, tables, hot descriptors and streams must fit the configured budget.

The optimized layout uses a range planner with configurable latency/bandwidth
assumptions. Library options are `r2LatencyMs` and `r2BandwidthMiB`; local search
also accepts `--r2-latency-ms` and `--r2-bandwidth-mib`. Defaults are 20 ms and
50 MiB/s. These are planning assumptions, not injected serving latency.

Competitive positional fetching is experimental and disabled by default because
it regressed this workload. Set library `competitivePositions: true` or local
search `--competitive-positions` to score coarse candidates first and verify
positions in ranked batches. The engine continues until a verified top K is
proven, falling back to the remaining candidates after two insufficient batches.
Exact totals retain exhaustive verification. Cache admission was not changed.

See [the sequential optimization report](bench/PAGED-OPTIMIZATIONS.md).

## Full Free Law Project demo

The deployed [Casework demo](https://work-search-demo.phulin.workers.dev/) supports
an opinion reader, highlighted result excerpts and signed pagination beyond the
first 100 matches. [Live coverage](https://work-search-demo.phulin.workers.dev/health)
shows whether the full official import is complete. See [demo operations and data
provenance](demo/README.md). The full import and early-partition text backfill run
locally; serving runs entirely on Workers and R2.
