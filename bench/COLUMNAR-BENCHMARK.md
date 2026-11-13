# Replacement benchmark ledger

The replacement runs on isolated live Workers. It is **not ready for full-corpus
adoption** while the scale, startup, load and native memory gates below remain.
The public demo has not changed. This ledger distinguishes completed measurements
from work still running.

## Latest measured iterations

The 10,000-attempt-per-engine finalist campaign finished over three randomized,
interleaved BOS sessions at four total offered arrivals/second. The same-source
1M frozen block control returned 9,996 correct responses and four admission 503s;
the packet replacement returned 9,992 correct responses and eight admission 503s.
Every successful request joined a native CPU observation. Complete-response
client P50/P95/P99 was 940/4,795/21,741 ms versus 746/3,436/5,360 ms. CPU was
446/2,170/14,347 ms versus 299/1,342/2,243 ms. Result metadata/snippet time was
56/135/249 ms versus 15/38/74 ms. Normal application reuse still traversed many
isolates; shared pages supplied almost all reads (six control and one replacement
origin GETs during measured responses). This is a warmed workload comparison,
not a production percentile or a fresh-isolate test.

Query/session-block bootstrap 95% intervals for client P99 were 6,322–28,175 ms
for the control and 4,505–6,193 ms for the replacement. The aggregate weights the
76 contracts approximately uniformly. Class-specific results remain separate:
held-out adversarial P95 fell from 21,201 to 4,545 ms (2,106 successes each), but
plain-common P95 rose from 967 to 1,035 ms (262/261 successes), field-body P95
from 758 to 900 ms (131/130), and zero-title-boost ties from 333 to 600 ms
(131 each). Small class tails remain uncertain. Client launch lateness P99 was
below 3 ms for both variants. These distributions, raw observations, source and
generation provenance, errors and uncertainty are `packets-1m-finalist-10000*`.
The much slower source-derived workload below is an additional adoption gate.

The source-derived 84-contract workload completed three sessions with 252
measured attempts on the 213-pair generation. All 245 successful responses were
correct; seven were admission 503s. Client P50/P95/P99 was 2,900/8,298/18,916 ms;
joined native CPU was 913/3,625/10,332 ms. Extending bounded frequency lookahead to
positional queries and coalescing their block reads returned 250 correct responses
and two admission 503s, with client 2,816/8,164/18,539 ms and CPU
996/4,108/11,900 ms. These were sequential pilots under concurrent construction
load, not an interleaved speedup result. The small wall-time change and higher CPU
do not justify retaining this experiment in the normal path. See
`packets-1m-source-heldout-{213,fetch}*`, including class-specific distributions and
bootstrap intervals.

Expanded pair construction selected 65,536 corpus-derived pairs under an 8 GiB
budget; the conservative payload bound is 8,288,553,192 bytes. Occurrences and
context remain in R2; CPD1 shards combine dictionary entries with small complete
postings, and 256 hot descriptors remain bundled. The generation is not yet
deployed or benchmarked. A live pilot matched existing occurrence chunk hashes,
all 64 sampled directory descriptors and every inline packet byte; see
`expanded-pair-native-validation.json`. This is correctness evidence, not a
coverage or latency result for the expanded generation.

The largest corpus contains 14,231,212 normalized terms. Its full serving directory
has not been built or deployed, so full-bundle fit remains unresolved. English
Snowball/Porter2 reduced 2,812,380 terms to 2,539,780 at 1M documents (9.69%), and
14,231,212 to 12,670,951 on all 10,032,254 documents (10.96%). Complete term counts
were checked against construction metadata. These diagnostics change no serving
semantics; see `stemming-{1m,full}.json`.

Native vocabulary construction had read about 7,100–7,400 dictionary pages and
308–313 MB per 1,024-document job. Routing all words together barely changed this
work and had mixed timing, so that experiment was rejected. A complete bundled
word-to-ID directory removed dictionary I/O. Its compressed prototype occupied
39,930,048 bytes and took 14.0/15.6/19.6 seconds on three native jobs. CWI2 replaces
small compressed blocks with directly readable 32-word restarts and packed prefix
lengths: 56,778,606 bytes for all 14,231,212 words. Every word round-tripped exactly,
and three native vocabulary outputs matched the frozen constructor byte for byte.
Wall times were 3.2/3.7/9.1 seconds versus 68.2/50.8/46.9 seconds for the recorded
remote counterparts, under concurrent construction load. These are diagnostic
timings, not a controlled throughput ratio. CWI2 is active for remaining vocabulary
jobs. The larger constructor bundle consumes memory headroom; native peak/retained
memory remains unproved. See `word-directory-full*` and `vocabulary-*-native*`.

The new source-derived workload exposes missing coverage: the 213-pair generation
has usable anchors for one of 84 contracts, and the 4,096-pair generation for seven;
four are fully covered by context. These are descriptor estimates, not measured
intersections or latency gains. Initial correct warmup responses on the smaller
generation included 20–33-second cases. One 32.9-second phrase response made 527
origin reads totaling 134.3 MB, with 51.7 MB decoded and 1,000 execution batches.
The batch counter does not measure the complete I/O dependency graph. Fresh-query
results must accompany the older workload; pair storage alone does not solve the
remaining broad phrase rejection cost.

All five full-corpus merge levels and all 4,004 posting jobs finished. Vocabulary
and packet conversion are running concurrently. Packet jobs now receive only
their reachable native object groups: one projected descriptor was 19,992 bytes
and 47 objects instead of 26,272,879 bytes and 63,764 objects. A continuation test
produced identical packet objects and directory blocks. This reduces metadata
work; a controlled throughput gain has not yet been measured. The posting
coordinator had exceeded V8's maximum string length when the checkpoint approached
512 MB; the verified immutable final run now replaces duplicated completed-phase
descriptors, reducing the active checkpoint to 23 MB. New posting jobs also stage
only their reachable lexical chunk descriptors. One new descriptor was 9,094 bytes
versus the old 40,879,443-byte corpus-wide descriptor. A continuation/boundary test
produced identical output objects. Existing partial jobs retain their old cursor
space. These are representation/work reductions; a controlled throughput ratio has
not been established. A later invocation-memory P99 sample reached 168,782,640
bytes without reported resource outcomes, so memory headroom is still unproved.

The completed finalist control is the frozen same-source 1M block layout,
distinct from the historical 4f97 baseline. Neither serving deployment changed
during that campaign.

The benchmark client now appends each completed observation to a JSONL journal and
compresses its final report after the measured requests drain. Previously, repeated
synchronous compression of the growing result array could perturb client launch
timing. A 12-request pilot verified the journal and final report contained identical
observations. Earlier campaigns retain their recorded launch-lateness measurements;
they are not silently reinterpreted as using the repaired client.

Packed snippet scanning reads body token IDs only until the first relevant token,
instead of expanding the entire body. In 304 requests per variant over two sessions,
decoded forward integers fell from 10,092,180 to 1,147,888. Client P50/P95/P99 changed
from 709/3,108/5,333 to 689/3,145/5,954 ms, and joined CPU from 323/1,224/2,301 to
269/1,087/2,126 ms. All responses were correct, with no HTTP errors. The change
retains its work and CPU reduction; the latency tail is mixed, not an established
P99 improvement. See `packets-1m-snippet-warm*`.

The wider corpus-selected pair generation completed with 4,096 pairs, 19,327,527
occurrences and 733,124,772 bytes. It covers 65,536 eligible words without consulting
benchmark query strings. A warmed comparison against the earlier 213-pair generation
returned all 608 responses correctly, with identical work counters on the existing
76 scenarios: 28,344 context integers and 45,028,472 ordinary position integers per
variant. Client P50/P95/P99 was 714/2,967/4,927 versus 670/2,999/4,650 ms. The wider
variant's native tail stream did not capture the measured requests, so its CPU
percentiles are unavailable. Overlapping tail sessions were observed and are now
avoided; causality is not established. This workload shows no benefit from the extra
pair storage. A fresh 84-query workload sampled from source token windows is being
validated independently to examine coverage beyond the old scenarios.

Parallel pair occurrence merging now partitions sorted key ranges using explicit
restart keys. A live replay merged 32 ranges in 100.9 seconds while full-corpus
construction was active. All 4,096 output packets, including positions and context,
were byte-identical to the previous complete merge. Old runs first required indexing
their chunk fences; new runs write them directly. The original serial final-merge
wall time is unavailable, and cache/load conditions were uncontrolled, so this is
an exactness and parallel-completion measurement, not a speedup ratio. See
`pair-range-replay-*`.

Bounded lookahead now prefetches up to four nearby numeric execution bands when
their coalesced physical footprint is at most 2 MiB. It uses conservative bounds
from the current heap snapshot; ordinary pruning still runs afterward. Positions
are excluded. Warming a range no longer concatenates cached pages into a temporary
packet. A 32,769-document exhaustive test covers ties, zero title boosts and
pagination across lookahead windows.

Two interleaved sessions on 37 nonpositional contracts measured 304 warmed
requests per variant at four total arrivals/second. Client P50/P95/P99 changed
from 465/1,817/2,954 to 427/1,591/2,095 ms; sampled CPU from 198/805/1,539 to
198/868/1,213 ms. Every answer was correct, with no errors. Fresh application and
shared namespaces, 152 requests per variant at two total arrivals/second, showed
the tradeoff: client 2,204/10,018/12,391 versus 2,390/7,511/10,496 ms, sampled CPU
314/1,349/2,423 versus 364/1,506/2,655 ms. The latter had three versus two admission
503s. Successful responses were correct. This improves the measured broad-query
tail while increasing cold median and CPU cost; these pilots do not establish
a stable P99 or a universal improvement. Raw results, class distributions and
query/session-block bootstrap intervals are `packets-1m-prefetch2-{warm,cold}*`.
The earlier copying prototype is retained as `packets-1m-prefetch-cold*`.

Six actual deployments tested the first search before a health request or warmup.
Version metadata confirmed each response came from the newly deployed version;
each had request number one. The complete responses were correct. The same
query was tried once with a fresh shared namespace and once after preparing its
shared pages before redeployment:

| Query               | Fresh namespace client / CPU ms | Prepared shared pages client / CPU ms |
| ------------------- | ------------------------------: | ------------------------------------: |
| Christenberry Allen |                      2,873 / 94 |                              643 / 53 |
| court               |                     3,911 / 407 |                           1,146 / 317 |
| `"the and of the"`  |                       905 / 120 |                            1,073 / 86 |

Reported module startup was 9–30 ms. This tiny deployment pilot is separate from
in-request application-cache reset; it provides no reliable tail estimate or
control of platform preparation or opaque R2 caches. The temporary startup Worker
was deleted. See `packets-1m-startup*` for complete deployment and source provenance.

A redundant single-word-phrase simplifier was rejected: parsing already produces
ordinary term nodes for single-word quotes. Its 240-request-per-variant comparison
had identical posting/candidate/position counts, no errors, mixed timings and no
established execution benefit. The redundant production change was removed;
`packets-1m-single-quote-{pilot,warm}*` records the null experiment. Exhaustive
quoted-word/proximity tests remain useful regression coverage.

A full-directory representation diagnostic round-tripped every one of the
2,812,380 entries, including float64 bounds and all addresses. Omitting implied
leaf spans and default counts, and predicting contiguous addresses, reduced the
128-term-block directory from 33.4 MB to 22.8 MB. Larger blocks reached 18.8 MB
at 1,024 terms, at the cost of decoding more metadata on a miss. This codec is
an offline experiment, not a measured live optimization or proof that the full
10M bundle fits. The running constructor still emits the validated CTD2 layout.

The remote-preview memory diagnostic reached a genuine Cloudflare preview, but
Wrangler 4.161.0 explicitly disables its inspector for remote mode. The preview
was stopped. Combined with the production profiler's 404 responses, native peak
and retained memory remain unestablished; see `remote-inspector-availability.json`.
At 09:26 UTC construction invocation-memory P99 reached 136,476,940 bytes; a later
09:52 UTC sample was 68,538,424 bytes. No resource-limit outcomes were reported in
either window. These lagged invocation samples are not peak-memory measurements,
and the higher observation leaves insufficient demonstrated headroom.

The full 10,032,254-document build completed ingestion and all five merge levels,
including all 576 intermediate and 96 final lexical jobs. Posting output is running. The
broader 4,096-pair generation is complete and deployed. Both coordinators encountered
client timeouts; completed immutable work was retained. Capacity-busy and network
retry budgets are now separate, preventing busy responses from exhausting the
network retry budget. The full index is not complete. Its independent source oracle
is waiting for the scoring root so validation can overlap package construction.

## Packet-path work, November 13

The native 1M block-layout generation `d989bc2c…` completed and is deployed on
`work-search-cws-worker-built`. Its independent oracle scanned all 1,000,000
documents and verified global statistics and query DFs. A 76-request live pilot
had no correctness errors: complete-response P50/P95/P99 were 1,097/6,047/26,238 ms,
and joined native CPU was 480/3,220/15,900 ms. With only 76 samples, P99 is the
observed maximum, not a stable tail estimate. The worst all-common-word phrase
decoded 202,779,676 position integers despite making zero R2 reads. This engine
is the same-corpus control for the packet replacement, not an adoption candidate.

The new packet/package path has completed a native 1,000-document build and live
independent validation. Generation `4a0b7ba7…` has 29,017 terms, a 398,748-byte full
directory, 25,428,688 bytes of frequency/position/block objects, and 14,987,553 bytes
of document packages. This conversion reused sorted native postings and range
vocabularies; its 226.9-second build is not a fresh end-to-end construction time.
Sequential per-document writes dominated that pilot. Subsequent construction
overlaps four writes and splits document ranges across invocations.

The first 76-request live packet pilot passed every scenario and warmup. Client
P50/P95/P99 were 75/142/369 ms, with native CPU 10/40/73 ms. These 1,000-document
numbers must not be compared with the 1M control as a speedup. Raw results and
CPU observations are under `results/columnar/packets-1000-pilot*`.

A randomized three-repeat forced-plan pilot issued 444 requests on the same 1,000
documents. There were no correctness errors; 99 document-plan requests were
explicitly unsupported by its strategy budget. Among 111 unambiguous paired
comparisons, complete terms had client P50/P95 80/298 ms and candidate packages
120/1,610 ms. Joined CPU medians were 12/20 ms. Candidate packages often won with
one to five candidates, but opening dozens or hundreds commonly lost even with
zero origin reads. Shared-cache operations and repeated decode/verification work
remained costs. Three repeats cannot establish a universal byte/candidate crossover
or reliable P99. See `packets-1000-crossover-summary.json` and the raw responses.

An interleaved same-deployment ablation compared multiple mandatory word anchors
with a single anchor. Both plans supported 123 of 222 requests and passed all
correctness checks. Multiple anchors had P50/P95/P99 89/366/643 ms versus
103/417/858 ms for one anchor; native CPU medians were 14/21 ms. This is a small
pilot with an evolving shared cache, not a final planner calibration. The packet
report separates workload classes and bins paired results by candidate count and
packed term-stream bytes.

Construction instrumentation subsequently attributed most document-job wall time
to R2 PUT waits: native CPU P50 was 750 ms while wall P50 was 12,393 ms (34 sampled
jobs). A grouped physical layout removed per-document PUTs while retaining direct
one-range candidate reads. Eight 1,000-document pilot jobs took 861–1,661 ms each;
the native conversion and publication took 21.2 seconds, reusing its term packets.
Its 2,656-byte bundled offset directory addresses all 1,000 packages. All 76 live
complete-response scenarios passed, with client P50/P95/P99 78/127/311 ms and native
CPU 11/35/73 ms. These warmed, noninterleaved pilot numbers do not establish a
serving speedup over the individual-object layout. Raw data is in
`packets-1000-grouped-pilot*`.

The 1M grouped packet conversion completed natively on the single builder deployment
in 41.1 minutes, reusing the completed sorted/scoring construction and term packets.
It contains 24,649,044,904 bytes of term/block objects, 20,143,777,366 bytes of
document packages and a 2,703,736-byte direct package directory.
Its initial 128-request burst hit application admission limits and stopped after
exhausting retries. Completed immutable jobs were retained; the resumed coordinator
uses adaptive concurrency and jittered backoff. No serving speedup is claimed
until repeated interleaved comparisons establish it.
Its completed term directory is 33,402,940 bytes for all 2,812,380 words, including
actual occurrence counts and direct stream references. The individual-PUT
document phase was stopped after the grouped pilot passed live correctness;
its term objects are reused. The latest usage check reported no Worker resource
errors and construction invocation-memory P99 of 50,286,160 bytes. Earlier
construction phases reached about 95 MiB. Neither is a peak-memory measurement.

Generation `c6ddc6f5…` deployed with 14 ms reported startup. All 76 measured
responses and all 76 warmups passed the independent 1M oracle. Complete-response
P50/P95/P99(max) was 904/4,307/18,847 ms; joined native CPU was 380/1,958/11,808 ms.
The earlier same-corpus control pilot was 1,097/6,047/26,238 ms. These pilots were
not interleaved and do not establish a stable speedup or P99. A failed production
sampling attempt overlapped only the early warmup, ending before measurement.
The all-common-word few-hit phrase remained an unacceptable 18.8-second case.

A controlled four-arrivals/second pilot completed 152/152 correct responses with
no HTTP errors: P50/P95/P99 939/4,722/20,040 ms, maximum 21,664 ms. Client launch
lateness P99 was 2.6 ms. Completion throughput including the long final drain was
2.61 responses/second; this is not a claim of sustained capacity. Invocation-memory
P99 reached 115,240,940 bytes in the first serving sample, below 128 MiB but with
limited headroom; these samples are not peak/retained-memory measurements.

A randomized 444-request 1M forced-plan comparison had no correctness errors.
Complete reads supported 69/222 requests, candidate packages 3/222; the remaining
strategies exceeded their budgets and explicitly returned unsupported. Only three
paired comparisons were available. This workload cannot calibrate the primary-plan
crossover. A separate 120-query workload now samples vocabulary DF bands and adds
intersections, sparse phrases and proximity. Its complete source scan verified
all query DFs and corpus statistics. A 720-request three-repeat comparison passed
all supported responses and provided 90 paired comparisons. Candidate packages
generally won at 1–16 candidates, were mixed at 17–64, and lost 25/27 comparisons
at 65–256 and all 9 at 257–512. Only 30 distinct contracts supported both paths.
The automatic planner chose the lower pilot-median strategy for 28/30 contracts;
the two disagreements were 7 ms and 43 ms, insufficient evidence for a new fixed
cutoff. Automatic serving passed all 120 held-out contracts at P50/P95
192/2,862 ms; the broad cases still use the block fallback.
Winner retrieval dominated some complete-read cases: its observed origin GET
P95 was 20 and maximum 100, with metadata time up to 1,114 ms. These classes and
raw counters remain separate in `packets-1m-crossover-summary.json`.

A randomized fresh-namespace range-transfer ablation issued 720 requests, with 198 supported comparisons and no correctness errors. Complete contiguous reads had P50/P95 433/817 ms versus 517/904 ms for 256 KiB page-at-a-time transfers. Median origin GETs fell from 30 to 20; result retrieval itself contributed 19. Each request reset application memory inside the search invocation and used a new shared-cache namespace; opaque R2 backend caches were not controlled. See `packets-1m-transfer-cold*`.

A subsequent randomized interleaved comparison completed 1,000 requests per engine across two sessions at four total arrivals/second. The packet replacement returned all checked answers correctly, without HTTP errors, at P50/P95/P99 736/3,709/5,663 ms; the same-corpus block control recorded 889/4,765/23,127 ms and two admission 503s. Joined CPU was 340/1,637/2,446 ms versus 417/2,267/12,933 ms. These are conditional scenario percentiles; class results and query/session-block bootstrap intervals remain separate in `packets-1m-interleaved-summary.json`. The 1,000 observations per engine are still below the finalist sample target. A separate 304-request in-request cache-reset run with existing shared pages passed all answers at 722/3,653/5,647 ms.

A numeric block executor now decodes scores into reusable query-owned typed arrays.
An interleaved comparison of 304 requests per version, across two sessions at four
total arrivals/second, passed every answer with no HTTP errors. Client P50/P95/P99
was 654/3,162/4,954 ms versus 790/3,726/5,001 ms; joined CPU was 292/1,159/1,964 ms
versus 338/1,720/2,444 ms. The P99 difference is inconclusive at this sample size.
The successful executor is now the normal packet engine; its temporary comparison
Worker has been deleted. Raw observations, uncertainty and class results are in
`packets-1m-batch-interleaved*`.

Local inspector profiles provide supporting attribution, not native memory proof.
For two repeated calls, estimated sampled cumulative allocation fell from 457 MB
to 372 MB on the heavy phrase and from 336 MB to 259 MB on the broad OR query.
Maximum observed heap plus backing storage increased from 140 MB to 150 MB across
these local captures. Collection timing was uncontrolled; this is **not** a
retained/peak-memory improvement. Raw profiles and compiled-bundle identities are
under `results/columnar/profiles`.

The following 152-request fresh-namespace pilot used the carried executor, reset
application caches inside each request, and gave every request a distinct shared
page namespace. It recorded three admission 503s; all 149 successful answers were
correct. Successful-response P50/P95/P99 was 3,657/20,801/30,143 ms, with CPU
467/2,639/5,872 ms. This cold-page condition remains unacceptable. The slow broad
phrases used 338–817 R2 GETs and approximately 87–211 MB per response: the block
fallback's page traffic, rather than result rendering, dominated these cases.
The ongoing wider pair build targets this work, but its benefit is not yet
measured. No claim is made about R2's opaque backend caches. See
`packets-1m-fresh-pages*` for errors as well as successful latencies.

Shared Cache API reads and writes now share a conservative 900-operation budget
per request, including secondary pair readers. Exhausting it falls through to R2
without changing coverage; `sharedBudgetBypasses` reports that extra work. This
avoids treating cache-call exhaustion as a query failure. Separate live exact-total
checks passed 14 contracts, including underfilled phrase heaps and the complement
of a corpus-verified term DF (`packets-1m-totals.json`).

Native positional/context pair construction completed on 1,000 documents in
17.7 seconds, producing 4,096 selected pairs, 183,102 occurrences and 6,599,560 bytes.
Its two numeric-token passes and four-way merges never parse display JSON.
The 1M pair pass completed with 213 pairs, 1,555,162 occurrences and 58,088,252
bytes. Its final occurrence/merge phase took 17.7 minutes, reusing the completed
corpus statistics. A tighter proved size bound replaced a wasteful bound that
selected only 190 pairs. All 76 measured responses and warmups passed the oracle:
P50/P95/P99(max) 667/3,551/5,357 ms, native CPU 271/1,542/2,201 ms. The earlier
18.8-second few-hit phrase fell to 416 ms and 26,881 position integers, from
202,779,676. These remain noninterleaved pilots, not a final traffic comparison.
The measured generation covers adjacent combinations of the 1,024 highest-DF words. The later 65,536-word pass and its measured limitations are described above. Selected descriptors currently fit in the bundle; a remote pair dictionary has not been implemented. Pair evidence now also restricts block fallback ranges and
eliminates ordinary word-position decoding where context proves a phrase; reference
tests cover scores, fields, negatives and matching snippets. Cheap context reads
can now precede the candidate-package budget decision; failed estimates preserve
the same evidence in block retrieval. A 2,151,197-byte winning package exposed the
application's old 2 MiB shared-entry cap, causing a repeated R2 read. The cap is
now 4 MiB, with write backpressure and a regression test. The follow-up 76-request pilot passed all answers. The same few-hit phrase used eight candidate packages and took 113 ms, with zero R2 reads and 676 decoded pair positions. Aggregate P50/P95/max was 685/4,688/6,657 ms, worse than the preceding session; the slow unaccelerated phrases retained the same work counts, so these noninterleaved runs do not establish an overall gain. Native captures still
returned HTTP 404/code 10393 despite a sustained active search invocation.

Fresh grouped construction of 128 documents took 22.0 seconds from source through
publication, with no reused scoring output. The actual group containing the longest
known document in the 1M corpus also completed: 128 documents, 567,448 tokens,
7,448,709 package bytes and 2,571 ms native wall time. Receipts are under
`results/columnar/construction`. The full 214-test suite passed after the cache-operation budget and bounded pair I/O overlap changes. An additional focused test checks out-of-order write completion, bounded write concurrency and read/write failure propagation.

The private benchmark and normal routes initially retained separate caches.
They now share one page/decoded/directory budget and one admission counter.
Earlier mixed-route invocation-memory P99 reached 125,915,490 bytes; the subsequent
corrected sample was 117,784,940 bytes. These cover different workloads and do not
establish a controlled memory reduction or a peak. Full available-corpus native
construction has started for 10,032,254 documents, using one Worker and R2.
All documents finished ingestion at approximately 08:52 UTC on November 13;
multi-level merging is running. Ingestion completion is not full index completion.
The sparse pair statistics merger retains one active and one prefetched chunk
per input and at most two pending output writes. A live replay produced identical
output bytes; later large merges still took 152–211 seconds on different inputs,
so these observations do not establish an I/O-overlap speedup.

Source validation now runs as bounded parallel jobs on that same constructor
Worker. A 1,000-document pilot matched all 76 contracts against the independent
Node scan. The complete 1M validation then finished in 604 seconds at 16 concurrent
requests, while construction was also running. All 1,397 returned scores/identities
and display records matched the established 1M oracle; maximum relative score
difference was 3.57e-16, within the existing cross-runtime tolerance. Independently
counted DFs and field-token totals agreed. This is a correctness result, not a
controlled validation-throughput comparison. Raw results, receipts and comparison
checks are in `results/columnar/oracles`. The 217-test suite passed before the
subsequent telemetry-only startup instrumentation; focused Worker tests also pass.
The historical 100k control Worker has been deleted after its comparison campaigns;
the frozen source revision, construction commands and results remain separate.

A rejected Cloudflare Queues dispatcher used the same Worker, not a Worker pool.
Of 1,024 dispatched jobs, 966 exhausted retries on the application capacity gate;
only 5,048 documents were produced. Completion-message counts initially concealed
those failures. The queue was drained and deleted, its source removed from the
normal path, and the original constructor restored. Successful immutable outputs
remained valid. Raw receipts and backlog metrics are retained in
`construction/queue-rejected`. This trial does not prove that Queues generally
cannot scale construction; it failed to improve this implementation.

## Comparison setup

The checkout began at `dd08b3c943362af8a3d404ed5cb6bc28d402b914`. The frozen control
archives `4f97eb49f1aa2115fbc3026c4924a1182a90917b`: unchanged global engine,
8 MiB bundled heads, 256 KiB physical pages and inline positional pairs. Its outer
wrapper adds request/isolate identifiers and authenticated cache namespaces.
Application resets execute inside the same POST as search; they do not assert a
new isolate. Core comparisons include metadata and query-relevant snippets and
disable response caching. No experiment claims control over opaque R2 caches.

The 100k replacement's independent-lane generation is
`f7c6dd43f97a78f21223c8123da8859bec9a169868bca181b832bf5d465d9f19`.
Its corpus hash is `e621b2654ab99a61b8f558dd912193002594de4086d8e1d560324637ef14fb06`.
Original 32 scenarios, fresh held-out expressions and field/pagination contracts
form 76 scenarios. Query-class results remain separate in the JSON reports.
The aggregate is a roughly uniform scenario mixture, **not production traffic**.

Each raw compressed run contains timestamps, seed, workload/options, cache state,
health/generation, request/isolate IDs, correctness, complete client time, arrival
lateness, errors and counters. Sanitized live tails provide sampled native CPU
and wall time joined by request ID. Tail coverage is incomplete. Deployment
manifests under `work/columnar-deploy` record runtime versions and source hashes.
Report code computes query/session-block bootstrap intervals; small pilot P99s
remain exploratory. Machine-readable raw and summarized data are in
[`results/columnar`](results/columnar).

## Substantial application-memory-reuse run

`finalists-memory` ran three randomized/interleaved sessions, 10,000 attempts per
variant, at 12 total arrivals/sec across the three variants. The local client was
in New England, with observed BOS ingress. Success percentiles include receipt
of the complete body and JSON parsing; rejected/timed-out requests remain in the
all-outcomes distributions and error counts.

| Variant            | Attempts |      P50 |        P95 |         P99 | HTTP 503 | Timeout |
| ------------------ | -------: | -------: | ---------: | ----------: | -------: | ------: |
| Frozen control     |   10,000 | 266.8 ms | 4,410.2 ms | 21,483.6 ms |      132 |       2 |
| V3 certificates    |   10,000 | 191.4 ms |   508.2 ms |    661.6 ms |        0 |       0 |
| V5 candidate masks |   10,000 | 188.7 ms |   483.6 ms |    632.6 ms |        3 |       0 |

All successful responses matched their independent/original oracle. Native CPU
P50/P95/P99 was 144/3,047/5,241 ms for 4,371 joined control observations,
77/212/304 ms for 4,268 V3 observations and 77/209/315 ms for 4,170 V5 observations.
Successful replacement maxima exceeded 21 seconds despite subsecond sampled CPU;
the raw client/worker timings should be consulted before attributing those
outliers to execution. Local corpus/pair work overlapped the campaign; brief
initial immutable uploads also overlapped. Background waiters originally polled
by inflating the raw result file; that avoidable local CPU work was removed.
These limitations are retained rather than treating a warmed cache as controlled
physical infrastructure.

## Measured iterations and rejected experiments

| Live pilot                       | Requests per variant | Complete P50/P95/P99 (replacement) | Finding                                                                                          |
| -------------------------------- | -------------------: | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| V1                               |                   64 | 758.8/1,267.3/1,581.4 ms           | Regressed against control 202.5/924.8/2,346.6 ms                                                 |
| V2 independent lanes/cache fixes |                   64 | 152.0/406.1/530.8 ms               | Improved against control 157.9/875.8/2,299.0 ms; small sample                                    |
| V3 expanded contracts            |                  200 | 191.3/427.9/522.8 ms               | Zero replacement errors; control had three 503s                                                  |
| V4 alternate pair selection      |                  200 | 233.9/550.1/706.6 ms               | Rejected; V3 was 182.1/408.8/483.6 ms                                                            |
| V5 candidate masks               |                  200 | 186.3/422.2/516.8 ms               | Retained; later substantial run above                                                            |
| V7 native synchronous gzip       |                  500 | 214.5/524.3/708.7 ms               | Rejected; V6 was 178.4/422.6/504.4 ms                                                            |
| V8 certificate band ordering     |                  500 | 182.9/422.2/504.4 ms               | Removed: no convincing aggregate gain against V6 181.2/426.3/517.2 ms, higher median sampled CPU |

V1 local workerd samples attributed roughly 39–71% of several queries' CPU to
rechecking CRCs on already-validated shared pages. The replacement now reuses
validation receipts, compiles coarse Boolean predicates outside candidate loops,
uses independent physical lanes, prunes conservative 128-document cells, and
reuses decoded blocks before fetching their source pages. Local attribution alone
was not considered proof of deployed gains. Native gzip is an explicit example
where a favorable microbenchmark failed the complete-response live comparison.

V6 additionally decodes positions only for requested fields, bounds deferred
shared-cache writes and records errors with telemetry. V9 freezes the current
runtime after removing unsuccessful band ordering; its substantial warm-shared,
empty-application-memory comparison is complete.

## Substantial empty-application-cache run

`final-warm-fra` completed three randomized/interleaved sessions with 10,000
attempts per variant and eight total scheduled arrivals/sec. A placed Frankfurt
Worker client fetched and parsed every complete response. Each search reset its
application caches inside that request; shared pages were warmed. This is neither
a new-isolate experiment nor control over R2 backend caches.

| Variant        | Attempts |    P50 |      P95 |       P99 | HTTP 503 |
| -------------- | -------: | -----: | -------: | --------: | -------: |
| Frozen control |   10,000 | 334 ms | 5,897 ms | 55,788 ms |      132 |
| Replacement V9 |   10,000 | 180 ms |   506 ms |    632 ms |        1 |

All successful responses passed the oracle. Native tails joined 9,868 successful
control requests and 9,999 replacement requests. Their CPU P50/P95/P99 were
177/3,596/8,060 ms and 81/220/319 ms, respectively. Worker wall P99 was
55,783/626 ms; client tails therefore cannot be explained by local result-file
processing alone. Client arrival-lateness P99 remained below 2.6 ms for both.

The query/session-block bootstrap P99 intervals were 15,619–60,774 ms for control
and 589–684 ms for V9. These wide control intervals matter: workload classes and
all-outcome/error distributions remain separate in
[`final-warm-fra-summary.json`](results/columnar/final-warm-fra-summary.json).
These are this scenario mixture's request percentiles, not production traffic.

## Regional observations

Two placed Worker clients fetch and parse complete upstream responses. Their
measurements are data-center client timings, not end-user last-mile latency.
Health and response placement headers identify SEA and FRA; request `cf.colo`
continues to identify ingress and is not used to claim execution placement.

V6 FRA: 1,000 attempts, no errors, P50/P95/P99 200/542/705 ms. V6 SEA: 1,000
attempts, one 503, successful P50/P95/P99 260/749/926 ms. Successful responses were
correct. An earlier 500-attempt-per-region run failed with HTTP 500 because the
client Worker lacked the public-fetch compatibility flag; those raw harness
failures are retained separately and excluded from engine performance claims.

## Scale and correctness

The direct 1M native generation
`cbf90efb330f43d3b8c2b014589dabf313dc1ed9af334d2c11e12c0869f2dd32` contains
1,000,000 documents, 2,812,380 terms and 58,183,344,294 serving bytes in 1,716
objects. Its canonical corpus hash is
`7776178824e974e234bcb8d6e5a6b32598a2bdd01311866217b4d8048e372fcc`.
The independent exhaustive scan verified corpus count/hash, token averages,
queried document frequencies and 76 ranked scenarios. The resumed build's
205.5-second wall time is **not a fresh-build time**: prior ingestion and checkpoint
work are separate. Its pair builder selected 332,693 pairs, 2,117,195 pair/document
rows and 2,383,914 occurrences, producing 276,612,344 bytes in 1,876 seconds.
Exact bundled certificates took about 51 seconds and occupy about 6.07 MB.

A fresh 1,000-document remote-spill build passed 96 live query/field comparisons
including metadata and snippet presence, using CRC metadata returned with R2
range reads. Its temporary R2 streams were successfully deleted. The attempted CI
build was removed, including its separate credential and temporary metadata.
Local full construction and the incomplete 1M bulk upload were stopped when the
user selected native Worker/R2 construction. No Actions build remains active.

The new TypeScript construction Worker reads archived source records directly
from R2, performs bounded external merging, emits CWS1 postings and numeric
forward blocks, and publishes a complete root. Its first 1,000-document build
produced 29,017 terms and 42.5 MB of serving data without a local index copy.
The independent R2 scan verified document count, average lengths, all workload
term DFs and exhaustive rankings. A live search Worker then passed 152 measured
complete responses over the 76 scenarios in two sessions, including metadata,
snippets and pagination. This corpus differs from the 100k comparison corpus.
The initial pilot oracle incorrectly omitted a cursor when a first page was
underfilled; that test bug was fixed before the passing run.

Coalescing contiguous source ranges reduced the same pilot from 453 to 193 sec;
bounded token-ID reuse reduced it to 169 sec; a compact ID dictionary and remote
checkpoints reduced it to 83 sec, and separating the ID lane reduced it to
42.35 sec. The parallel pipeline took 103.94 sec with one Worker and 30.97 sec
with eight Workers on the same 1,000 documents. Its additional job boundaries
cost time with a single Worker. These are single construction pilots, not
serving latency claims. Raw task receipts, source generations, and phase
totals are in [`construction`](results/columnar/construction). All eight largest
known compressed source records, including a 599,294-token document, completed
live ingestion. This does not establish native peak memory.

On 32,768 documents (49,816,555 body tokens, 245,653 terms), the first parallel
pilot was stopped after 18 minutes with document output incomplete. Its fixed
fan-in produced an almost serial penultimate merge. Two native observations
showed 21–22 sec wall time against 1.2–1.6 sec CPU, pointing to dependent I/O.
Balanced merge levels, lexical final ranges, contiguous row batches, four
concurrent reads and two pipelined writes reduced the completed merge phase
from 656 to 97 sec with eight Workers. Grouped lexical token-ID resolution
reduced dictionary transfers from 5.22 GB for 15,408 completed documents to
2.35 GB for all 32,768 documents.

The completed optimized build took **480 sec with eight Workers** and **259 sec
with 32 Workers**, including publication. These were sequential single pilots,
not randomized repeated build trials. The 32k source has only eight ingestion
and document jobs in those runs, limiting utilization; the coordinator now
creates more balanced ingestion jobs. The completed generations occupy about
1.47 GB. R2 backend cache state is opaque and was not controlled.

An independent full source scan verified the 32k count, average field lengths,
workload DFs and exhaustive rankings. Its live serving Worker passed 152 measured
responses over 76 scenarios in two sessions: P50/P95/P99 179/373/875 ms, no errors.
All 152 requests joined native CPU observations (57/171/560 ms). Responses
included checked titles/metadata and snippet strings; snippet matching also has
independent small-corpus tests. These are exploratory scenario statistics with
too few samples for a reliable P99. Raw results are `worker-built-32768*`.

Construction now uses one deployed Worker with up to 128 concurrent HTTP
invocations and a bounded per-isolate queue. A live 16-invocation ingestion test
completed all requests across 11 isolates; the previous immediate admission
rejection returned six 503s in 16 attempts. The complete 1,000-document build
through one deployment took 41 sec and produced the identical serving generation
as the eight-deployment pilot. These are small diagnostic pilots, not evidence of
full-corpus throughput. The unused builder pool and serving experiments were
removed, reducing the account from 501 to 344 scripts (157 task deployments).

The old 1M document-output diagnostic was stopped after its scoring index
completed: individual requests often transferred over 100 MB of dictionary data
for a few dozen documents. A replacement range-vocabulary pilot against that
same 1M scoring index prepared 1,024 documents with 60.8 MB of dictionary reads;
the next request wrote 841 documents with zero dictionary reads. The ongoing
1M run reuses the completed scoring index and records that reuse explicitly;
its elapsed time must not be presented as a fresh full build.

The configured construction region
is `aws:us-east-1`; an authenticated outbound trace observed IAD. The bucket
reports ENAM, a coarse geography rather than a precise server location. The
frozen control and current serving benchmark Worker use the same region setting.
No additional Frankfurt or Seattle campaigns were started. Object verification
is divided into 256-object jobs; publication checks their generation-specific
coverage receipts instead of issuing an unbounded number of HEADs in one request.

The available published R2 source contains 10,032,254 documents across 254
partitions. This is not proof that the entire official CSV snapshot was imported.
The later 1M complete-response measurements are recorded above. Largest-corpus live
search performance remains pending and is not inferred from these smaller runs.

The earlier 196-test validation included independent exhaustive small corpora,
70k-vocabulary hierarchical routing, adversarial compound winners absent from
single-term certificates, phrases/proximity/negatives, long repeated documents,
fields/boosts, deterministic ties, search-after, corruption, generation consistency,
workerd R2/Cache API and concurrent admission. Native unit tests and fmt/clippy
also pass. Unicode tests preserve unpaired UTF-16 IDs/metadata/passages and exact
preview slicing. Rust float64 scores are checked with the user-authorized relative
1e-11 tolerance; cursors are verified independently and use the tested engine's
returned score.

## Memory, profiling and remaining gates

The earlier control used a 24 MiB page cache; the packet engine uses 12 MiB for
pages/packages, 4 MiB decoded columns and 2 MiB decoded directory groups. Active numeric
buffers, pending shared-write bytes and cumulative decoded/inflated bytes are
reported separately. Local inspector heap plus backing storage reached about
93.6 MB with concurrent requests, including pending garbage. Forced collection
was unavailable; this is neither native peak nor native retained-memory proof.
Admission allows two active requests per isolate and reports excess work as 503.

Repeated production CPU/heap profile API attempts returned HTTP 404, code 10393,
“No recent executions were found,” despite concurrent successful traffic and both
an exact active version and `latest-deployed`. Native tail CPU/wall observations
are available; production allocation attribution and peak/retained memory remain
unestablished. The current `stages` counter counts execution batches, not a full
I/O dependency graph. These are measurement gaps, not zero-cost observations.

Cloudflare's invocation memory quantiles are now collected by
`scripts/cloudflare-usage.ts`, alongside resource errors, account script count,
CPU usage, R2 requests and stored bytes. These sample isolate memory at invocation,
and do not establish native peak/retained memory or cumulative allocation.
Adaptive analytics can lag and report new scripts as `__unknown__`, so attributed
construction totals alone are incomplete. At the first post-cleanup check there
were no reported resource-limit outcomes; the search bucket had about 27.9M reads
in the preceding hour, including the stopped diagnostic and other work. The high
read amplification prompted the dictionary-path replacement above.

Remaining adoption gates: substantial finalist results; controlled load ladders
with queueing/rejections; live correctness/performance on the full available
snapshot; native retained/peak memory under load; and identification/optimization
of scale-specific bottlenecks. See [the design](COLUMNAR-DESIGN.md) for the final
format and reproducible construction/deployment commands. Current official limits
and profiling behavior are documented by [Cloudflare](https://developers.cloudflare.com/workers/platform/limits/)
and its [production profiling documentation](https://developers.cloudflare.com/workers/observability/profiling-in-production/).
