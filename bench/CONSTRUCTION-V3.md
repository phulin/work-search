# Construction redesign: measurements and current status

The new implementation builds the existing serving format directly. It does not
change matching, scores, pair context, snippets, or the public demo. The full court
build that was already running was stopped; its checkpoints and objects remain.

## Pipeline

Ingestion writes independently compressed sorted blocks and separate term
summaries. Summary reduction assigns exact lexical IDs and global frequencies
without reading positions or revisiting every document. It produces an immutable
catalogue with common words, complete remote word routing, and pair vocabulary.
Workers load that catalogue by reference; deployment is not a build dependency.

After catalogue construction, posting finalization and document packaging run
concurrently under one request limit. Finalization consumes a merge directly,
checks every term against the catalogue, and writes serving packets and binary
metadata. There is no final sorted run or JSON-to-packet conversion pass.

Packaging analyzes each field once and resolves missing IDs in batches. The same
numeric tokens feed document encoding and pair statistics. Compressed numeric
blocks preserve every token and its original position. Selected pair occurrences
are extracted from these blocks, without rereading display text or packages.

Groups accept up to 1,024 documents, with additional byte/token bounds. Intermediate
blocks have independent checksums and restart points. Multiple blocks share R2
objects and contiguous requested blocks share GETs. Pair processing and merging
preserve sorted document lists; no bitmaps are introduced.

The initial settings are 256 KiB logical blocks and 16 MiB intermediate objects,
using deltas followed by gzip. A native 18-configuration comparison found that
16 MiB objects substantially reduced writes. At 256 KiB, delta+gzip produced
10.84 MiB versus 46.29 MiB uncompressed, with 3 versus 49 PUTs when comparing
16 MiB compressed objects with 1 MiB raw objects. CPU rose from 2.53 to 4.05 seconds,
but elapsed time fell from 14.23 to 7.42 seconds. These are single observations
per configuration, with identical inputs and concurrency one—not an established
optimum. Input GET counts were identical. Verification downloads are separate.

Tasks bind source, code, analysis, catalogue, parameters, and restart state.
Receipts are per task. A replay reports current I/O separately from original work.
New tasks reject old cursors and changed input identities. Publication checks
term/document coverage, statistics, generation, object metadata, and verification
receipts before writing an immutable root. Temporary construction Workers use
separate names; the active constructor and demo are untouched.

## Native measurements

Source: first court-filtered archived documents from
`work/court-cases-full/source/source-root.json`; analysis `nfkc-lower-porter2-v1`.
The control is separately preserved in `bench/columnar/control/construction-v2.tar.gz`.
Its expanded SHA256 is `71a29105af89bbfa058c0666093707e71f40d48ad62230bf61bdd2de60b849c4`.
`prepare-construction-control.ts` records measurement additions, the 1,024-document
validation repair, and two bookkeeping repairs required to publish the control.
It retains the original construction algorithms.

| 1,024 court documents; concurrency 4 | Control | Replacement |
|---|---:|---:|
| Base + pairs elapsed | 187 s | 89 s |
| Logged GETs | 2,070 | 436 |
| Logged PUTs | 1,064 | 221 |
| Logged HEADs | 432 | 49 |
| R2 bytes read | 982 MiB | 145 MiB |
| R2 bytes written | 166 MiB | 139 MiB |

The control omits some coordinator transfers and helper verification operations;
its operation/byte totals are lower bounds. The replacement includes coordinator
I/O. Separate base and pair reports and exact configuration identities are in
`bench/results/columnar/construction-v3/`. The elapsed figure adds the control's
base and pair durations, excluding the idle interval between them. There is one
matched run; it is insufficient to establish timing uncertainty.

The 8,192-document replacement completed in 224 seconds at concurrency 8.
It includes a retried Bad Gateway response and 68 busy responses. There were no
reported resource-limit failures. The source oracle independently verified query
DFs and global field totals. All 76 query contracts passed ranked IDs/order,
metadata, fields, pagination, and underfilled exact totals; maximum relative score
difference was 2.03e-16. Construction fixtures additionally test Unicode, stemming,
repeated terms, empty fields, common-term continuation, duplicate delivery,
corruption, missing objects, and changed-generation rejection.

The 1M build has started on the isolated Worker. It is not yet validated.
Subsequent ingestion CPU changes and their separate native comparison are in
[CONSTRUCTION-CPU.md](CONSTRUCTION-CPU.md). The running build retains its original
Worker code; its coordinator was resumed after a temporary download failure.
Later pair-occurrence merging hit R2 same-object read throttling (10058).
The coordinator now retries that specific transient error with bounded exponential
backoff and jitter, while retaining fatal handling for validation/corruption errors.
The same 1M build was resumed from completed tasks, with the coordinator change
recorded in its manifest. No source processing or Worker deployment was restarted.
The first retry classifier covered GET only; a later PUT throttle stopped the
fourth occurrence-merge round. Classification was expanded to R2 operations
including writes, with tests retaining fatal handling for invalid data. The same
completed tasks were reused again.
The engineering targets—20x fewer GETs, 2x fewer PUTs, and 3x faster elapsed—are
not all met by the small matched run: writes meet the target, reads and time do not.
Do not extrapolate its ratios to 1M or the full corpus.

## Reproduction

Use yarn throughout. The deploy command requires a new isolated name and refuses
to replace an existing deployment containing different code:

```sh
yarn node --import tsx scripts/deploy-fresh-construction.ts work-search-cws-fresh-NAME SOURCE_ROOT
yarn node --import tsx scripts/build-fresh-in-workers.ts COUNT OUTPUT BUILD_ID https://work-search-cws-fresh-NAME.phulin.workers.dev SOURCE_ROOT
```

`CWS_BUILD_CONCURRENCY` bounds all branches together. The manifest records codec,
logical/physical sizes, common/pair limits, source identity, analysis, deployment
code, coordinator hash, and starting checkpoint. Restart the identical command.
For controls, prepare a separate directory with
`yarn node --import tsx scripts/prepare-construction-control.ts OUTPUT_DIRECTORY`.
Run its deployment/build/pair commands from there with an explicit isolated
`CWS_BUILD_URL`; never use the active constructor by default.

For the source oracle, deploy `bench/columnar/deploy-isolated-oracle.ts` with an
isolated oracle name. Set `CWS_SOURCE_ROOT`, `CWS_BUILD_URL`, and
`CWS_ORACLE_WORKERS`, then use `oracle-in-workers.ts INDEX regression OUT
--construction-v3`. `validate-construction.ts INDEX ORACLE OUT` checks search
against those source results. `construction-v3-report.ts OUT BUILD...` aggregates
current request costs, including retries. `construction-codecs-report.ts` joins
codec measurements to Cloudflare CPU observations by CF-Ray.

## Remaining work

The 1M and full-corpus gates remain. Native peak/retained memory and cumulative
allocation have not been measured; analytics memory percentiles are not peaks.
The constructor allows one active request per isolate and rejects excess work.
A published root and HEAD checks do not independently re-decode every output byte;
checksums are validated during construction and reading. Staging is retained for
restarts until dependent validation finishes; automatic deletion of shared,
content-addressed objects still needs a safe retention procedure. The default
build commands have not yet switched away from the legacy coordinator, pending
the 1M gate. Some small cold packets remain duplicated in serving objects and
inline shards; there is no reread/copy pass, but those extra writes remain.

Cloudflare documents 128 MB isolate memory, 64 MiB uncompressed bundles, and up to
300,000 ms CPU for paid HTTP Workers. The six-connection restriction concerns
waiting for response headers. See the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
Native runs establish admission for the tested requests; they do not establish
peak memory or control opaque R2 backend caches.
