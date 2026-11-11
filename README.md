# Worker Bundle Search

A standalone TypeScript full-text search engine. The Worker contains a binary term dictionary, document IDs and lengths, and selected compressed postings. Remaining postings use immutable R2 objects and byte-range reads. No remote dictionary, database, framework, or external search service.

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
GET /health
```

Default implicit AND; optional implicit OR. Explicit Boolean grouping, NOT, quoted phrases and proximity are supported: `(red OR blue) AND "fox jumps"`, `red /5 fox`, `red /s fox` (25 tokens), and `red /p fox` (75 tokens). See [query language](docs/QUERY.md) for Lexis-style precedence, exact matching rules and limits. NFKC Unicode normalization, lowercase, and Unicode letter/number tokenization. No stemming, stop-word removal, or language-specific word segmentation. Tokens with no separator (for example a CJK sentence) form one token. Distinct terms score once; repeated tokens inside phrases remain significant. Empty queries return no matches; AND queries containing missing terms return immediately without reads. `field` is `all`, `title`, or `body`; `titleBoost` defaults to 2 (0–20); `limit` defaults to 20 (1–100). Queries allow at most 16 distinct terms and 2,048 UTF-16 characters. Invalid requests return 400, unknown routes 404, storage/corruption failures 503.

Results contain external IDs and scores. `total` is an **exact** count of matching documents: this implementation exhaustively combines lists before ranking. Ties use internal input order. BM25 is computed separately for title/body lengths, using the union document frequency for each term, then summed with title boost. Field restrictions reuse that union DF. Metadata/title are fetched only with `metadata=true`; body text is not returned.

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

`deploy` verifies the bundle and every object SHA-256 against the manifest; signs R2 S3 HEAD/PUT requests; skips already-present objects only if generation, checksum metadata, and length match; uses conditional creation for missing objects; selects the exact binary; then runs Wrangler deployment. Upload must complete before the Worker changes. Runtime R2 access uses **only the binding**, never S3 or public HTTP. S3 credentials stay on the build machine. `--bucket` must match the bucket binding in `wrangler.json`. Credentials were unavailable during development: cloud upload/deployment has **not** been validated against an account.

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

Queries retrieve up to four remote ranges concurrently. A conservative working-set estimate rejects oversized queries rather than allocating unbounded typed arrays. Concurrent requests share an isolate and can still exhaust memory; large, common-term queries may exceed the Free plan's 10 ms CPU limit. Paid Workers are appropriate for that workload. Default exact-total queries score every matching candidate; total=false enables block-max score pruning after decoding. Adaptive v5 planning skips irrelevant posting blocks, and a bounded warm-isolate cache can retain complete verified postings. There is no pivot-WAND iterator. Metadata filters, root expansion/wildcards, automatic word variants, and incremental updates are not implemented. Position/phrase queries add storage and CPU costs; see [bench/SPLIT-POSTINGS.md](bench/SPLIT-POSTINGS.md).

## Benchmarks and layout

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

Adaptive query planning is enabled by default. HTTP `total=false` (CLI `--no-total`) enables exact top-K block-max score pruning and omits the match count. Default queries retain exact totals. This is score pruning after frequency decoding; it does not implement a pivot-WAND iterator or avoid all broad-list decoding. Initial score-bound construction costs CPU; warm calls can reuse bounds.

The Worker retains up to `CACHE_MIB` MiB of complete verified decoded postings and score bounds (default 4, configurable 0–8; set 0 to disable). The cache is per warm isolate, scoped to immutable generations, and constrained by query memory headroom. Cache-cold queries and lists exceeding capacity still read/decode normally. Concurrent requests can still exhaust isolate memory even with a bounded cache.
