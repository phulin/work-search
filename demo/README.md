# Casework demo

Live: https://work-search-demo.phulin.workers.dev/
Coverage: https://work-search-demo.phulin.workers.dev/health

Performance: [realistic full-request benchmark](../bench/DEMO-REALISTIC.md), using
a frozen 67-partition deployment and measured Worker/R2 latency distributions.

The full official Free Law Project snapshot import runs locally and publishes
immutable index partitions and opinion text to a private R2 bucket. Workers serve
the page, search API, highlighted excerpts, full-text reader and cursor pagination.
The page clearly marks incomplete coverage while the import runs. A completed
snapshot is indicated only after all nonempty opinion rows have been indexed.

## Source

Official September 30, 2026 bulk snapshots:

- `https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/opinions-2026-09-30.csv.bz2` (55,252,643,429 bytes)
- `https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/opinion-clusters-2026-09-30.csv.bz2` (2,467,613,433 bytes; 10,174,551 case metadata records)

Unlike earlier benchmarks, this is not a COLD Cases sample. It imports every
nonempty opinion text from the official opinions snapshot. One searchable document
represents one opinion, so a case with multiple opinions can yield multiple hits.
The first nonempty text representation is used: plain text, citation HTML, other
HTML variants, Harvard XML, then scan XML. HTML/XML is converted to text. Empty
text records are counted separately. Original compressed downloads are retained.
Titles/dates/status come from the matching case-metadata snapshot; missing case
metadata does not cause opinion text to be dropped. Display metadata additionally
joins clusters to dockets and courts and collects reporter citations from the same
snapshot's `dockets`, `courts`, and `citations` bulk files. The snapshots are not a fully
transactionally consistent database export.

## Search and reading

Queries default to AND and support Boolean grouping, phrases, `/n`, `/s` = 25
and `/p` = 75 token positions. These are not actual sentence/paragraph boundaries.

Global BM25 uses total document count, exact aggregate field lengths and summed
per-term document frequencies from every participating partition. Shards return
their top K under those same statistics, and routers merge with a stable
score/shard/document tie-breaker. Local block score bounds are disabled for this
global-statistics path because they were computed using partition-local stats.
Generation vectors prevent combining stats/search results across a deployment.

Pagination uses HMAC-signed continuation tokens containing the query, global
statistics, generation vector and last score/shard/document. Tokens expire in one
hour. New partitions imported after page one are excluded from that search until
the query is restarted. POST requests carry cursors, avoiding URL-length limits at
large partition counts. The engine keeps only the next top K, not an ever-growing
result offset. It can revisit postings on later pages; this is correctness-first
pagination rather than retained server-side traversal state. The demo API accepts
1–50 results per page (20 by default), with an extra internal hit for next-page
detection.

Opinion bodies are individually gzip compressed in packed R2 objects. A 32-byte
per-document catalog points to compressed text and metadata records. The reader
streams decompressed text, renders it safely as text with highlighted terms, and
provides match navigation and printing. Results show an excerpt around the first
matching term where available. Excerpt generation scans at most 8 MiB of an
opinion before falling back to its beginning; the full reader remains available.
The early index partitions receive a separate full-text backfill. Missing text
is marked as still importing, with a link to the original CourtListener opinion.

Results show the court's full name, a readable decision date, reporter citations,
docket number and publication status where supplied. The reader also shows judges,
the full caption and the snapshot's citation count. Approximate dates are labeled.
Source gaps are identified explicitly rather than showing internal IDs as captions.

An independent display-metadata generation repairs previously blank captions using
`case_name`, then `case_name_full`, then `case_name_short`, with a docket-caption
fallback. The initial importer only fell back on a null marker and missed empty
strings; the fresh-snapshot importer now uses the same corrected fallback.
Full-name fallback recovers 162,925 of the old missing captions. Existing immutable
index generations and input checksums remain valid. This repairs result display;
terms absent from previously indexed title fields require a future index rebuild
to become searchable in that field.

The display lookup uses a sparse 16-byte catalog per cluster ID (4,194,304 IDs per
64-MiB catalog object) and independently gzip-compressed JSON blocks packed into
64-MiB R2 objects. A block holds at most 256 records or approximately 256 KiB of
uncompressed text; the decoder enforces a 1-MiB expansion limit. Targeted range reads validate generation, identity
and CRC. Its independent generation is published only after every object is
uploaded and checked. A bounded, conservatively charged 4-MiB / 512-record cache
reduces repeat lookups; these bytes do not occupy the bundled index budget.
Metadata and excerpt retrieval run concurrently after ranking. Serving still uses
only Workers and R2; the join database remains local build tooling.

## Operations

Wrangler OAuth is used for deployments. A randomly generated internal token lives
only in ignored `work/full-flp/secrets.json` and Worker secrets. It protects shard
endpoints and the streaming R2 upload endpoint. Public read/search routes contain
no credentials. R2 object keys, generation metadata, sizes and SHA256 values are
checked on upload; CRCs protect index pages and content metadata. Full opinion
bodies are verified by gzip decoding and source document identity during packing.

Local state and logs are under ignored `work/full-flp/`:

- `published.json`: deployed partition names, generations, counts and source hashes.
- `batches/*.json`: durable source row ranges, normalized input hashes and counts.
- `supervisor-status.json` / `supervisor.log`: running job PIDs and retry counts.
- `deployment-complete.json`: only written when the full index is deployed.
- `viewer-publishing-complete.json`: full-text backfill completion.

Downloads use ETag-pinned ranged reads and resume checkpoints. The text exporter
can consume completed contiguous download ranges without reading unwritten holes.
Builders operate on bounded JSONL batches. Uploaded temporary files are removed;
compressed source archives and provenance are retained. The supervisor resumes
interrupted jobs and owns an idle-sleep assertion that ends with the jobs. Keep
the machine running while the local import finishes. No containers, databases or
search servers are required for serving; SQLite is used only in offline tooling.

Reproduction/resume building blocks:

```sh
uv pip install --python work/flp-venv/bin/python indexed_bzip2==1.7.0
# Download both sources with scripts/download-flp.py.
python3 scripts/import-flp.py --metadata
work/flp-venv/bin/python scripts/import-flp.py --decoder-threads 4
node --import tsx scripts/full-flp-pool.ts
node --import tsx scripts/watch-full-flp.ts
```

For the court/caption lookup, download `dockets-2026-09-30.csv.bz2`,
`courts-2026-09-30.csv.bz2`, and `citations-2026-09-30.csv.bz2` from the same
official bulk-data location using `scripts/download-flp.py`, then run:

```sh
work/flp-venv/bin/python scripts/build-case-metadata.py
node --import tsx scripts/redeploy-demo.ts
node --import tsx scripts/publish-case-metadata.ts
```

Join stages checkpoint committed row counts and resume on restart. Packing can be
rerun deterministically. The standard-library bzip2 reader works without the optional
parallel decoder for small fixtures. The original import database is preserved so
concurrent index builds and full-text backfills retain their exact source hashes.

The demo deployment helper currently names the task's dedicated Workers and R2
bucket and uses the configured Cloudflare account. Review those names before
using it in another account. Never publish the local secrets or raw job logs.
Deployments retry transient Cloudflare API failures, including the observed
initial-create propagation error `10007`, before consuming a supervisor restart.

## Validation during import

The automated suite passes 140 tests, including global-ranking equivalence,
cursor tampering/expiration, 400 hits across 20 pages without duplicates, and
Unicode opinion-text/metadata/excerpt round trips. Local Worker integration tests
remain part of the suite. On the deployed demo, seven successive pages returned
140 unique opinions while retaining page one's coverage during concurrent imports.
Browser checks verified Next/Previous pages, highlighted excerpts, click-through
full text and match navigation. These checks used a partial corpus; full-snapshot
completion and deployed latency benchmarks remain separate work.
Metadata tests build official-shaped CSV fixtures end to end, recover both full
and docket captions, join courts/citations, reject corrupt or mismatched records,
and check display formatting and emitted browser code.
The complete lookup joins 10,174,551 clusters against 72,998,758 source docket
rows and 18,130,235 reporter-citation rows. It occupies 1,041,378,252 bytes across
16 immutable objects, each at most 64 MiB (82.9% smaller than the initial
6,081,096,228-byte record layout). Only 14 source cases lack a recoverable
caption and four lack a docket/court join. The packed statistics' `recoveredCaption`
counts the two additional docket-caption recoveries; the 162,925 full-name
recoveries occur earlier when normalizing cluster names.
Live checks after activation verified recovered captions on both search and
reader endpoints, court names on all 32 results across two pages, no duplicate
opinions between pages, and the expected court/docket/reporter citations for
`Christenberry v. Allen`. The browser reader displayed a previously blank caption
with the Southern District of Alabama, filing date and docket, alongside its full
opinion and highlighted search terms. Full corpus import remains ongoing.

## Performance rollout and reproducible comparisons

[Sequential measurements](../bench/DEMO-OPTIMIZATIONS.md) compare packed result
cards, global-statistics block skipping and the corpus-wide term directory.
`PERF_LEVEL` selects the cumulative path: 0 is baseline, 1 enables cards, 2 also
uses global block bounds, and 3 adds directory routing when a directory is bundled.
Index bundle budgets stay at 8 MiB per partition. The optional gateway directory
root has its own 1-MiB cap inside the gateway's existing 8-MiB budget.

For an existing frozen benchmark snapshot and mirrored data:

```sh
node --import tsx bench/build-demo-cards.ts
node --import tsx bench/upload-demo-cards.ts
node --import tsx bench/build-demo-routes.ts
node --import tsx scripts/upload-demo-routes.ts
node --import tsx scripts/upgrade-demo-shards.ts --all
DEMO_OPT_STAGE=3 node --import tsx bench/demo-local.ts --hydrate
DEMO_OPT_STAGE=3 DEMO_MODES=empirical-repeated,empirical DEMO_PHASES=reset,repeat \
  DEMO_OUTPUT=opt-stage3 node --import tsx bench/demo-local.ts
DEMO_OPT_STAGE=3 node --import tsx bench/demo-setup.ts
DEMO_OPT_STAGE=3 node --import tsx bench/capture-demo-stage.ts
node --import tsx scripts/redeploy-demo.ts
```

Uploads finish before the directory bundle pointer changes. Partition upgrades
use isolated temporary entries and their archived index generations; they do not
race on `data/bundle.bin`. Deployment completion markers pin both source hashes and index generations,
permitting interrupted upgrades to resume while still deploying later code changes. Deployment API calls use bounded asynchronous child processes.

The directory builder merges the entire frozen vocabulary with a disk-backed
external merge and bounded per-partition sorting, not the scenario queries. Reusing
its completed-partition checkpoints is safe for the same immutable snapshot.
Its coverage can lag the live import: uncovered or changed generations always
supply ordinary statistics and remain searchable. Retain old directory objects
while any deployed Worker references that root. Card sidecars likewise remain
immutable and must be retained for active generations and pinned cursors.

To refresh coverage for all currently published partitions without replacing the
frozen benchmark snapshot:

```sh
node --import tsx bench/build-demo-routes.ts --all
node --import tsx scripts/upload-demo-routes.ts --out work/full-flp/term-routes
node --import tsx scripts/redeploy-demo.ts
```

The tested directory covers the frozen 67 partitions. The public corpus continues
to grow; new partitions use the ordinary path until a refresh includes them.
