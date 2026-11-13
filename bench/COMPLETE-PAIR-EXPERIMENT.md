# Complete pair membership on the local 1M generation

This experiment uses the existing stemmed 1M generation. The 10M build remains
stopped. All membership encodings are sorted document-ID lists; there are no
bitmap representations. Common-word presence uses the same list encoding.

The [planner follow-up](PLANNER-REGRESSIONS.md) keeps this pair/context format
unchanged and addresses optional-read decisions. Context-budget experiments are
outside that round's scope.

Construction reads compact token IDs from the verified local document packages,
separately for body and title. The first scan materialized 1,497,515,111 adjacent
pair occurrences in 435 seconds, including vocabulary loading. It retains the
bounded external partitions for packet/context-size comparisons without another
corpus scan. Packet construction and its final sizing measurements are separate.

The complete build contains 44,995,185 distinct pairs, 990,101,772 pair/document
memberships (991,610,351 when fields are counted separately), and 1,497,515,111
occurrences. Compressed membership records use 4,066,200,876 bytes before context;
context adds 10,477,292,324 bytes. Of all pairs, 98.965% qualify for the 8 KiB
payload rule. The 166,490 packets occupy 15,778,447,162 bytes; 323 individual
records exceed the target, and the largest packet is 448,814 bytes. The binary
router is 6,504,782 bytes. The 200 separate common-word presence objects occupy
63,708,440 bytes and stay out of the bundle. Packing took 900 seconds after the
435-second occurrence pass. These are measured 1M sizes, not 10M projections.

The packet router has namespaces for 128 corpus-selected common first words.
Their successors split by string-hash prefixes. Other first words share a tail
namespace. Prefix partitions split until packets fit the 128 KiB target; an
individual larger record gets its own object. Routing uses two 32-bit hash
components, and exact normalized UTF-8 keys establish identity inside the packet.
A real collision in the initial 32-bit router triggered the wider routing; it
did not silently merge identities or drop records.

Each record stores exact pair identity, body/title counts, body/title memberships
and optional positions with one token of context on either side. Lists have
independent 128-document packed blocks, with offsets and final-document restart
keys for binary search and skipping. The singleton case stores one document ID.
The serving cursor reads numeric blocks without a JavaScript object per posting.
Only the requested record decodes; neighboring membership payloads remain binary.
Context is included when the complete membership and context payload fits 8 KiB.

N and M affect anchor selection, never stored coverage, exact filtering, scoring
or OR/NOT semantics. Common words rank by corpus DF with numeric-ID tie ordering;
common pairs rank by union DF and then ordered numeric IDs. Ordinary anchors
exclude the configured common sets. An all-excluded phrase uses an excluded
anchor. A required pair absent from its authoritative packet rejects the phrase.
Unquoted conjunctions never gain an adjacency condition. OR branches and negated
phrases cannot supply an anchor unless the full AST proves it mandatory.

Bundled statistics select one or two pair packets before I/O. Selected memberships
start in the same fetch wave, alongside needed term metadata and selected common
presence filters. Candidate intersections retain same-field pair membership and
reject using inline context where possible. Small survivors use document packages;
larger sets restrict block bands and cells. A strategy-budget fallback keeps the
same candidate predicate and pair evidence. It never restarts an unrestricted scan.

When only one membership without context is needed, its exact field/union count
is already available. There is no preliminary counting scan. Block execution
retains a numeric membership cursor across ascending document bands. An excluded
pair's bundled zero field count can still reject a mandatory phrase immediately.
Candidate package lengths are available in the bundled document directory, so an
over-budget candidate transfer changes strategy before downloading packages.

Named immutable packets use the existing bounded application cache, shared cache,
six-slot I/O scheduler, concurrent-read deduplication and checksum validation.
The router stays binary; it does not expand into a map of every pair. Common-word
presence is separate from ordinary score/position data. At most two useful
mandatory common-word filters are prefetched, using corpus DF as the first cost
prior. Their scoring contributions still come from score streams or packages.

```sh
# First scan, then packet construction. All data are local; neither deploys.
yarn node --max-old-space-size=6144 --import tsx scripts/build-pair-membership.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m partition
yarn node --max-old-space-size=6144 --import tsx scripts/build-pair-membership.ts work/columnar-worker-stem-1m work/columnar-complete-pairs-1m pack

# Interleaved baseline and planner-only variations on identical postings.
CWS_PLANS=auto CWS_PAIR_INDEX=work/columnar-complete-pairs-1m \
CWS_PAIR_SETTINGS=50:500,50:1000,50:2000,100:500,100:1000,100:2000,200:500,200:1000,200:2000 \
CWS_REPEATS=3 yarn node --import tsx bench/columnar/simulate.ts work/columnar-worker-stem-1m work/columnar-bench/oracle-native-stem-1m.json
```

The builder reports distinct pairs, union and field document memberships,
occurrences, encoded membership/record/packet bytes, context eligibility, packet
counts and router bytes. Common-pair exclusion group sizes are reported for M =
500/1,000/2,000. The router has an explicit 8 MiB budget: a larger result requires
a larger packet target and repacking rather than a mandatory remote routing level.
The occurrence materialization is shared by these construction variants; N/M
variations reuse every packet byte. Full Workers memory/startup and live latency
remain finalist validation after local correctness and modeled-I/O comparisons.

## Local grid and measured corrections

The first grid completed 600 measured responses: 20 contracts, ten plans (the
control plus nine N/M combinations), and three interleaved repeats. All 600
matched their reference results with no errors or unsupported queries. Eight
contracts use a fresh exhaustive 1M token scan with independent phrase matching,
frequency checks, BM25 computation and ranking. Their returned snippets must
contain the normalized matching phrase. The remaining twelve are existing
source-reference contracts. This pilot establishes neither production traffic
percentiles nor a useful P99 estimate.

The local control is the same stemmed CTD3/CTF3 packet engine without complete
pair membership. This measures the incremental pair/planner change, not a
comparison against the historical legacy engine or its unstemmed live results.

The grid used normal bounded application-memory reuse and independent 1 GiB
modeled shared caches per plan. Origin reads cost 20 ms plus transfer at 100 MiB/s;
shared reads cost 2 ms plus transfer at 1,000 MiB/s. Complete engine responses
include metadata, snippets and JSON serialization, without response caching.
Node CPU, local disk and timer scheduling remain diagnostic, not native Workers
measurements. Raw files retain the corpus/analysis identifiers, router checksum,
implementation digest, query contract and I/O model.

At N=100/M=1,000, example per-contract medians from that grid were:

| Contract                                 | Control ms | Complete pairs ms |
| ---------------------------------------- | ---------: | ----------------: |
| `"because level the pip"`                |        461 |                15 |
| `"and absent a showing"`                 |      1,919 |               636 |
| `"the an of"`                            |     11,836 |               892 |
| `"the and of the"`                       |     15,554 |               703 |
| `"burden of proving"`, body              |        321 |               416 |
| `"in the"`                               |        520 |               801 |
| `"in the absence of"`, title (zero hits) |        484 |               591 |

There was no clear N/M winner. M=500 helped several natural common phrases;
larger exclusions helped an unusual all-common phrase. N had smaller effects in
this small workload. Thresholds remain planner settings, not reasons to rebuild
or drop stored coverage.

Counters exposed repeated membership decoding on the broad two-word phrase:
5,084,382 integers decoded for a 725,271-document membership. The cursor/count
correction reduced this to 1,455,740 integers. A five-repeat focused follow-up
measured `"in the"` at 573 ms versus 613 ms for its interleaved control, and the
title-only zero-hit phrase at 17 ms versus 559 ms. Those are small-sample medians.

After the package-length correction, a second interleaved pilot completed 400/400
correct responses: the control and N/M = 50/500, 100/1,000, 200/2,000 across the
same 20 contracts with five repeats. Selected medians at N=100/M=1,000 were:

| Contract                          | Control ms | Complete pairs ms |
| --------------------------------- | ---------: | ----------------: |
| `"the and of the"`                |     16,021 |               493 |
| `"the an of"`                     |     11,653 |               604 |
| `"because of the pip"`            |        888 |               486 |
| `"and absent a showing"`          |      1,335 |               679 |
| `"in the"`                        |        638 |               630 |
| `"in the absence of"`, title      |        614 |                19 |
| `"burden of proving"`, body       |        369 |               451 |
| `"in the absence of"`, all fields |      1,132 |             1,323 |
| `the pennsylvania`                |        226 |               255 |

Package preflight eliminated 8,727,261 wasted package bytes and 626,830 forward
integers per attempt on `"because of the pip"`. Its candidate set still reaches
the complete block continuation. The baseline and pair variants both receive
this general package-length check in the second pilot. Residual regressions
remain: membership work can cost more than it saves when a broad ranked query
would verify only a few competitive candidates. Larger M can also exclude a
useful pair and leave a larger unigram anchor. N=100/M=1,000 remains the starting
configuration; these samples do not establish a universal winner.

Validation also completed the full 160 existing independent 1M contracts at
N=100/M=1,000, with application caches reset inside each measured call. All 160
passed, plus their untimed warmups. This was a correctness replay with minimal
modeled delays, run concurrently with other validation; its timing is not a
performance comparison. The repository suite passed 240 tests in 64 files,
including native workerd tests. TypeScript and changed-file formatting passed.
The first restricted suite attempt timed out waiting for local runtimes; it was
stopped and rerun successfully with native runtime access.

The storage audit checked all 166,490 packet sizes and CRCs and every record's
spans, counts and list modes. It also checked exact routing and decoded union
membership for 10,985 distributed records (336,498 document IDs). All totals
matched construction. This is not an exhaustive source-to-pair identity audit.
Although context covers 98.965% of distinct pairs, it covers only 19.31% of pair/
document memberships and 15.72% of occurrences. The 10.48 GB context cost and
larger router/cache footprint need a separate context-budget comparison; the
vocabulary percentage alone overstates the amount of verification work covered.

Raw results, contracts, build sizing and summaries are in
[`results/columnar/pair-membership-1m/`](results/columnar/pair-membership-1m/).
The storage audit can be repeated without rebuilding:

```sh
yarn node --import tsx bench/columnar/pair-storage-report.ts work/columnar-complete-pairs-1m work/columnar-bench/pair-membership-1m-storage-report.json
```

The complete pair index is local. These packets have not been uploaded to R2,
and this format has not passed native 1M Workers memory/startup/load validation.
It is not ready for full-corpus adoption.
