# work-search

Exact Boolean, phrase, proximity, and ranked search for Cloudflare Workers and R2.
The default build, search, development, and deployment commands use the engine in
`src/columnar`. Construction runs in Workers with bulk data in R2; a local
coordinator schedules jobs and records resumable checkpoints. Serving requires
no external search service or database.

See [architecture](docs/ARCHITECTURE.md), [storage formats](docs/FORMAT.md),
[query semantics](docs/QUERY.md), [document verification](docs/COLUMNAR-VERIFICATION.md),
and [complete phrase execution](docs/EXACT-PHRASES.md).

## Setup

Use Node.js 22.13 or newer, Yarn Classic, and Rust 1.93 or newer for the native
builder and tests. Node 26 is recommended for reproducing the 1M experiments.
The TypeScript corpus tools use Node's built-in SQLite support. Wrangler provides
Cloudflare authentication; `.env.example` lists optional account and R2 settings.

```sh
yarn install --frozen-lockfile
yarn run check
yarn builder:check
yarn test
```

A fresh cloud checkout can run these checks without Cloudflare credentials or
local indexes. Tests build their own fixtures and run Workers locally. Install
dependencies while network access is available; subsequent checks use local
files. The 1M benchmark contracts are in `bench/fixtures`; their large index data
is separate from Git and must be prepared before running those benchmarks.

For a prepared 1M index and suffix data, run a cold comparison with exact totals
off using `bench/columnar/run-suffix.ts INDEX_DIR SUFFIX_DIR OUTPUT.json.gz`.
Set `CWS_SUFFIX_MANIFEST=manifest-numeric.json`,
`CWS_SUFFIX_PLANS=control,suffix16-max`, and `CWS_CONTROL_COMMIT=21ff91a`.
Historical controls require the corresponding Git commit to be available; fetch
it from origin if the cloud checkout is shallow. No remote data reads occur
unless `CWS_PREPARE_REMOTE=1` is explicitly set. `CWS_CAPTURE_DATA=FILE.json`
records the required byte ranges during untimed preparation to size a portable
dataset without copying the entire suffix index.

To copy that measured coverage into a new directory, run:

```sh
yarn node --import tsx bench/columnar/export-suffix-data.ts \
  INDEX_DIR SUFFIX_DIR CAPTURE.json NEW_DATA_DIR
```

The output contains `engine/`, `suffix/`, and `contract.json.gz`. Run the same
benchmark with those directories and `CWS_CONTRACT_PATH=NEW_DATA_DIR/contract.json.gz`.
Set that variable during export too if capture used a different query contract.
The reader verifies data before timing, makes no network requests, and rejects
queries needing missing ranges. This copy supports the captured experiments;
keep the full index separately for new workloads and construction.

## Build and search

Input is JSONL with `id`, `body`, and optional `title` and `metadata` fields.
The remote constructor consumes an archived source root. Given an existing
published corpus, these commands prepare the source, deploy the constructor,
and schedule a build:

```sh
yarn node --import tsx scripts/construction-source.ts work/full-flp/published.json work/court-cases-full/source/source-root.json
yarn columnar:deploy:builder work-search-cws-fresh-example work/court-cases-full/source/source-root.json
CWS_BUILD_CONCURRENCY=8 yarn build-index 1000000 work/cws-1m corpus-1m https://work-search-cws-fresh-example.phulin.workers.dev work/court-cases-full/source/source-root.json
yarn search-local work/cws-1m '"summary judgment"'
yarn dev work/cws-1m
```

Repeat an identical build command to resume. Choose a new build ID and output
directory when source data or construction code changes. The coordinator
checks source identities and task inputs before reusing completed work.
`scripts/columnar-corpus.ts` extracts a JSONL corpus from a downloaded official
snapshot; `scripts/download-flp.py` and `scripts/import-flp.py` prepare that data.
The native alternative is `yarn builder:index --input CORPUS.jsonl --out INDEX_DIR`.

`yarn search-local INDEX_DIR QUERY [OPTIONS_JSON]` accepts search options as its
third argument. `CWS_REMOTE_URL` permits fetching missing immutable objects;
`CWS_LOCAL_DATA` selects an already prepared local object store.

## Prepare and deploy

```sh
yarn prepare-deploy INDEX_DIR work/columnar-deploy/preview work-search-cws-preview
yarn bundle INDEX_DIR
yarn deploy INDEX_DIR work-search-cws-example
```

Preparation writes a Worker entry and Wrangler configuration locally. Deployment
publishes checksum-verified immutable objects and then deploys the Worker.
`--deploy-only` checks already published objects without uploading them.
Metadata columns and complete-pair membership can be supplied with
`--metadata DIR --membership DIR` to preparation, bundling, and deployment.
Build metadata columns with `yarn columnar:metadata`; pair and complete-context
builders live in `scripts/build-pair-membership.ts` and
`scripts/build-exact-phrases.ts`.

## Tests and tools

`tests/` covers formats, construction, exact matching and ranking, pagination,
metadata filters, publication, and local workerd/R2 integration. `bench/` keeps
benchmark drivers, profilers, reference evaluators, and the historical readers
used by regression tests. Shared input query definitions live in `bench/fixtures`.
Generated results, profiles, and reports are ignored by Git. The construction
control preparation tool accepts an external archive instead of storing a source
snapshot in this repository.

Local indexes, construction checkpoints, mirrored objects, and credentials live
under ignored `work/`, `indexes/`, and `.wrangler/` directories. `src/global`,
`src/format`, and the older demo remain implemented for their existing commands
and regression tests; the architecture document identifies their boundaries.
