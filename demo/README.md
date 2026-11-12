# Casework demo

Live: https://work-search-demo.phulin.workers.dev/
Coverage: https://work-search-demo.phulin.workers.dev/health

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
metadata does not cause opinion text to be dropped. The snapshots are not a fully
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

The demo deployment helper currently names the task's dedicated Workers and R2
bucket and uses the configured Cloudflare account. Review those names before
using it in another account. Never publish the local secrets or raw job logs.

## Validation during import

The automated suite passes 135 tests, including global-ranking equivalence,
cursor tampering/expiration, 400 hits across 20 pages without duplicates, and
Unicode opinion-text/metadata/excerpt round trips. Local Worker integration tests
remain part of the suite. On the deployed demo, seven successive pages returned
140 unique opinions while retaining page one's coverage during concurrent imports.
Browser checks verified Next/Previous pages, highlighted excerpts, click-through
full text and match navigation. These checks used a partial corpus; full-snapshot
completion and deployed latency benchmarks remain separate work.
