# Generic document metadata filters and replacement deployment

The replacement accepts a request-scoped `Options.documentFilter` in every executor. `prepare(sortedInternalDocumentIds)` returns a synchronous acceptance predicate for that batch. Preparations may overlap; providers must keep their batch state independent. There is no per-document network callback. Applications with existing aligned metadata columns can supply their own provider.

Rejection happens before positional matching and heap admission, and before candidate packages or deferred block scores are read. Unfiltered head certificates are disabled for filtered queries. Text statistics, BM25, title boosts, float64 scores, tie ordering, and excerpts are unchanged. Exact totals count accepted text matches according to the existing cursor contract. Complete term execution still reads its complete frequency packets before applying metadata; filters do not manufacture a selective text anchor.

## Worker API

POST `/search` adds an optional `filter` expression:

```json
{
  "q": "\"summary judgment\" AND arbitration AND \"third party beneficiary\"",
  "exactTotal": true,
  "filter": {
    "and": [
      { "field": "date_filed", "op": "gte", "value": "1990-01-01" },
      { "field": "date_filed", "op": "lte", "value": "2020-12-31" },
      { "field": "precedential_status", "op": "eq", "value": "Published" }
    ]
  }
}
```

GET accepts the same expression as JSON in the `filter` parameter. Supported operators: `eq`, `ne`, `in`, `lt`, `lte`, `gt`, `gte`, `exists`; Boolean composition: `and`, `or`, `not`. Fields are explicitly typed scalar strings, finite numbers or booleans. Strings compare exactly, independently of text stemming/normalization. Dates can use ISO strings. Missing/null values fail comparisons, including `ne`; use `not` or `exists` explicitly to include absence. Unknown fields, type mismatches and excessive expressions return 400 before index I/O. A filter without a configured metadata manifest also returns 400.

Filtered search-after requests repeat the query/filter, `generation`, and returned `metadataGeneration`. A metadata generation mismatch returns 409. An application signing cursors must bind the filter and both generations, as well as its other query options.

## Metadata storage and construction

CWM1 is an optional sidecar, not a change to CWS1 postings or document packages. Its manifest binds the base generation, document count, schema, contiguous ID coverage and immutable column addresses. Each block covers up to 4,096 documents. Numeric values are float64 with NaN denoting absence; strings use a local exact dictionary and uint32 codes; booleans use one byte per document. There are no bitmaps. Only fields referenced by the filter are read. Raw columns use the existing bounded memory/shared-page cache and read deduplication.

Active encoded columns are batched to 4 MiB, with at most two preparations running concurrently per filter. Decoded batch columns are released after computing a sorted accepted-ID list. This is a buffer budget, not a measured whole-isolate memory bound: dictionaries, cache entries and query buffers also consume memory. Diagnostics expose filter candidates/rejections, column visits/bytes and I/O-bearing batches. The latter can overlap and are not a count of strictly serial stages.

Build from explicit internal IDs, never assumed corpus input order:

```sh
yarn columnar:metadata INDEX_DIR schema.json aligned-metadata.jsonl METADATA_DIR
```

Schema example: `{"court_id":"string","date_filed":"string","precedential_status":"string"}`. Each input row is `{"doc":0,"metadata":{...}}`; every internal ID must appear exactly once in ascending order. Join external enrichment to these IDs before construction.

Alternatively, stream metadata already stored in local document packages:

```sh
CWS_LOCAL_DATA=work/columnar-local-data yarn columnar:metadata \
  work/columnar-worker-stem-1m work/columnar-metadata-1m/schema.json \
  --packages work/columnar-metadata-1m
```

This validates content-addressed groups and only inflates their display metadata section. It does not tokenize or change contexts/excerpts, and has no remote fallback. The completed 1M sidecar contains filing date, publication status, opinion ID and cluster ID. It took 28.7 seconds locally and occupies 29,068,533 bytes across 974 immutable column objects. Court/jurisdiction enrichment is not present in the source package metadata and must be joined separately for Casework.

## Local 1M verification

`bench/columnar/metadata-filters.ts` runs the query above, checks filtered ranking against the complete unfiltered 94-result ranking, and checks search-after. It randomizes/interleaves three repetitions per condition, each with complete metadata and snippets. Simulation: 20 ms origin, 2 ms shared cache, 100/1,000 MiB/s bandwidth respectively; six source slots; 12 MiB application pages and 4 MiB decoded cache. Empty means empty application and simulated shared caches. Warm uses an untimed prime with a high cache-operation budget; measured searches retain the normal 900-operation budget. No response caching, downloads or Cloudflare execution.

| Query filter          | Matches | Empty median | Warm median | Score postings decoded | Empty GETs |
| --------------------- | ------: | -----------: | ----------: | ---------------------: | ---------: |
| None                  |      94 |     2,228 ms |      284 ms |                413,329 |        257 |
| 1990–2020 + Published |      43 |     3,402 ms |      404 ms |                183,334 |        617 |
| Date after 2099       |       0 |     1,222 ms |       38 ms |                      0 |        217 |

These are tiny pilot samples, not P95/P99 or production claims. Process CPU includes GC. The date/status regression is real in this model: 408 field-block visits add reads and cache pressure despite less score/position work. Parallel preparation reduced its initial 4,020/507 ms empty/warm medians to 3,402/404 ms without changing results. Future work should evaluate metadata block bounds and co-located field reads before assuming filtering accelerates every query. No excerpt optimization was performed.

Small-corpus tests independently enumerate the full unfiltered ranking before applying the reference filter, covering broad OR, conjunctions, phrases, negative phrases, top-K exclusion, totals, fields, ties and cursor traversal across complete-term, package and block execution. Local workerd tests exercise HTTP filters, generation conflicts, invalid input and zero-score-fetch rejection. Publication tests reject mismatched metadata/directories and incomplete package identity. The full suite passes: 274 tests across 75 files, plus TypeScript and formatting checks. The complete 1M bundle also initializes and serves health in local workerd; that harness measurement is not a live startup latency claim.

## Preparing and publishing a generation

Local preparation needs no credentials and never fetches, uploads, or deploys:

```sh
yarn prepare-deploy work/columnar-worker-stem-1m work/columnar-deploy/ready-1m \
  work-search-cws-ready-1m \
  --membership work/columnar-complete-pairs-1m \
  --metadata work/columnar-metadata-1m

yarn bundle work/columnar-worker-stem-1m \
  --membership work/columnar-complete-pairs-1m \
  --metadata work/columnar-metadata-1m
```

This checks bundled directory digests, generation/count alignment, package-offset coverage, metadata digests and local auxiliary object sizes. Generated `entry.ts` explicitly supplies the pair router, N=100/M=1000, common-word presence descriptors and metadata manifest. `preflight.json` and `auxiliary-objects.json` report actual data and publication inventory. The current 1M configuration has 25.4 MiB bundled data, 8,034 document groups, 11,616 posting objects and 167,664 pair/presence/metadata objects. Unused legacy CRC arrays are omitted from the serving root.

Future live command, **not run in this iteration**:

```sh
# Publish missing objects, verify dependencies, and deploy the replacement.
yarn deploy INDEX_DIR work-search-cws-casework-1m \
  --membership PAIR_DIR --metadata METADATA_DIR
```

The uploader accepts complete-pair, common-word presence and metadata objects. Deployment first prepares and size-checks the actual Worker locally, then validates group sizes/digests/document boundaries and auxiliary identities; it fails on missing dependencies. `--publish-only` stops after publication; `--deploy-only` requires all data already published. Health checks require matching base, metadata and pair generations plus N/M settings, so an older deployment of the same base index is not mistaken for the new configuration. `yarn deploy ... --prepare-only` is also entirely local. Source and configuration preparation happen before any credential lookup in that mode.

The same commands accept a larger compatible generation; pair construction no longer rejects every count except 1M. Build it through the existing resumable Worker builder, then produce its complete pair index and aligned metadata. This iteration did **not** start a full-corpus build or establish its bundle size/startup/memory/latency. Preparation rejects bundled data alone at or above Cloudflare's documented [64 MiB limit](https://developers.cloudflare.com/workers/platform/limits/); compiled code also counts. The isolate has 128 MB shared by concurrent requests. A larger directory/router may require a smaller hot-term allocation or a representation change; passing a document count to the CLI is not proof of full-corpus readiness.

Casework itself is unchanged. Its app adapter still needs to translate legal filters, bind the new backend, align enriched legal metadata and preserve its alternate sorting/cursor contract before switching the public demo.
