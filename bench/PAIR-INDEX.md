# Corpus-selected adjacent-word sidecar

The pair experiment is an immutable auxiliary index. It prunes candidate documents for exact phrases and leaves the original unigram BM25 scores, full positional verification, fields, and Boolean semantics intact. It does not cache queries or select phrases from benchmark workloads.

## Construction and selection

`src/global/pair-build.ts` streams the corpus twice. A deterministic vocabulary selects up to 4,096 words by descending corpus document frequency (lexical tie breaks, minimum DF 100). The first pass tracks exact within-field adjacent-pair document frequencies and delta-varint byte costs in three fixed V² Uint32 arrays. Title/body boundaries never form pairs. Both passes verify the exact source generation; the base root generation must match the hash commitment to that source checksum and the original immutable packs.

Selection ranks observed pairs by `pairDF * (min(leftDF,rightDF) - pairDF) / estimatedRawBytes`. The DF difference predicts avoided unigram candidates; pair DF weights corpus occurrence opportunity, rather than a supplied query workload. Byte cost includes exact delta-varint bytes plus a descriptor allowance. Selection uses 85% of the configured storage budget; the final compressed packs plus binary root must also fit the hard budget before publication. This is a corpus-derived heuristic, not an optimal latency predictor.

The second pass spills selected `(pair,doc)` records to SQLite with an 8 MiB page cache and disk temporary storage. Postings are emitted in blocks of at most 4,096 documents. Dictionary entries and postings live in gzip-compressed PagePacker payloads; the binary sidecar root embeds only the sparse dictionary-page directory. Neither existing base packs nor base bundles are changed. Offline statistics use 192 MiB at V=4,096; transient state is bounded by V², the SQLite cache, pack buffers, and the largest input document rather than the corpus token count. The complete source bundle and top-vocabulary selection also occupy builder memory.

A separate full-universe analysis (`scripts/analyze-pair-statistics.ts`, `work/pairs-4096-coverage.json`) finds 3,303,318 observed pairs in the 4,096-word vocabulary, whose least frequent word has DF 2,039. These represent 87,530,816 pair-document incidences, requiring 128,275,987 exact delta-varint bytes before gzip and dictionary metadata. Including the descriptor allowance estimates 589,134,583 raw bytes for all observed pairs. This vocabulary covers 145,855,201 of 187,782,352 within-field adjacency occurrences (77.67%); rarer vocabulary falls back safely. Any phrase containing an excluded word already has a unigram candidate upper bound below 2,039 documents in this corpus, which limits the cost of this coverage restriction. The estimate is not a measured full-index compressed size.

## Runtime

`PairFilter.queryCandidates(ast)` returns a complete candidate superset, or `undefined` for unpruned search. It batches independent phrase dictionary reads across the AST, then batches postings for the smallest selected pair in each phrase. All reads use PageReader, including CRC, decompression limits and generation-scoped cache keys. Up to 32 positive phrase clauses and an aggregate 32,768 pair-document entries are admitted. Oversized clauses fall back safely. AND/NEAR intersect available supersets, OR unions only when both sides are bounded, EXCEPT uses its left side, and negated branches never prune.

An adjacent pair can occur without the full phrase aligning. Every surviving document still undergoes the original exact positional check. A pair appearing in the body also cannot establish a title phrase match.

Optional multi-pair mode uses constructor argument four: `new PairFilter(manifest, reader, 32768, true)`. The default remains smallest-pair only. The optional mode admits each phrase's smallest pair first, then extra pair lists in ascending corpus DF within the same aggregate cap. It fetches them in the same bounded postings stage and intersects all admitted lists for each phrase. Skipped lists leave a conservative superset. Full phrase alignment is still required, including cases where all pairs occur at different positions. Additional lists can increase bytes/requests, so this option must be measured separately from the control.

## 100k FLP build

Input: `bench/generated/flp-100000/corpus.jsonl`; source: `bench/generated/flp-100000/source`; base: `work/global-100k`.

Fresh sidecar: `work/pairs-100k-v4096-utility32`.

- Generation: `69376f80d3811c441621ef00367051a8db45409e2202fc775dd269a64153aba5`
- Base generation: `dd3b7cedcea7ce22d6228be930507c55b636d001c0c13e5cfba74833150e01f0`
- 11,813 selected pairs; 164.4 seconds construction.
- 21,303,716 bytes total immutable index; 20,426,526 bytes compressed postings; 4,516-byte root. SQLite is construction scratch and is not uploaded.
- With the existing 7,927,644-byte heads-8 root, the two binary roots total 7,932,160 bytes. These budgets measure bundled index data. Wrangler separately reports code and compressed deployment size.

Cold local selectivity measurements below compare the full unigram document intersection to that intersection after pair filtering. Local milliseconds are not Worker latency predictions. The chosen pair list alone can be larger than the intersection; the executor intersects it with ordinary unigram candidates.

| Phrase                        | Unigram candidates | After pair filter | Reduction | Pair requests / bytes |
| ----------------------------- | -----------------: | ----------------: | --------: | --------------------: |
| appellant contends            |             11,749 |             2,377 |     79.8% |           2 / 131,072 |
| advice of counsel             |              2,079 |               981 |     52.8% |           3 / 196,608 |
| clear and convincing evidence |              2,447 |             1,880 |     23.2% |           3 / 196,608 |
| as a matter of law            |             29,970 |            15,220 |     49.2% |           5 / 327,680 |

`absent a showing`, `summary judgment`, `of the`, `court of appeals`, `in the absence of`, and `burden of proof` obtain no pruning in this configuration. Missing pairs and oversized pair lists fall back to the base engine, but cold dictionary discovery still costs 1–3 requests and 64–192 KiB in these examples. Thus corpus selection does not guarantee acceleration for every phrase; native end-to-end latency must include discovery costs.

A negative-control selection weighted by `minUnigramDF` instead of observed `pairDF` selected 76,362 mostly highly selective but unnatural pairs in 7.95 MB, and did not cover the sampled natural phrases. Expanding that vocabulary from 1,024 to 4,096 changed no selected pairs. These discarded builds remain in `work/pairs-100k-32` and `work/pairs-100k-v4096-32` for comparison. The selector does not read these examples or any workload file.

## Larger storage comparison

The same 4,096-word vocabulary and corpus-only selector with a 128 MiB storage budget produced `work/pairs-100k-v4096-utility128`, generation `e977e72177d12e7a98590534385efd7ebf21ca58096ec0c4b82ca952d6c7c7aa`. It contains 199,011 pairs in 86,964,647 total bytes, including a 63,911-byte root and 79,241,837 compressed posting bytes, and took 447.9 seconds to build. The exact same selection rule and corpus are used; only the storage budget changes.

Smallest-pair-only control: `absent a showing` falls from 3,873 unigram candidates to 1,276 (67.1%); `court of appeals` 40,193 to 28,090 (30.1%); `summary judgment` 12,488 to 9,521 (23.8%); `burden of proof` 8,434 to 5,585 (33.8%). `advice of counsel` remains 2,079 to 981. These candidate counts do not establish end-to-end latency improvement. Machine-readable local measurements are in each sidecar directory's `selectivity.jsonl`.

## Optional corpus-wide rare-pair coverage

The third build mode is explicit: `--inline-rare` / `PairBuildOptions.inlineRarePairs`. Within the unchanged corpus-selected vocabulary it includes every observed pair with document frequency at most 16 before spending the remaining storage estimate on the existing utility-ranked larger pairs. No benchmark query affects inclusion. The root advertises `entryEncoding: "binary-v2"`; remote dictionary values contain versioned binary records. Tiny lists store delta-varint document IDs directly in those values, eliminating their separate gzip frame and posting-address descriptor. Larger lists retain paged postings with compact binary descriptors. Existing JSON sidecars remain readable; the default build and runtime flags remain unchanged. Unknown entry-encoding features are rejected explicitly.

Inline-mode dictionaries have a hard 128 KiB raw payload limit. Larger pending groups split before packing, and compressed payloads may span physical pages. Thus 32 independent dictionary references fit the 8 MiB expanded batch ceiling. A query whose selected pair is inline needs only the dictionary stage. When a phrase has such a tiny inline anchor, multi mode intersects only its inline lists and avoids remote large-pair extras for that phrase; other phrases retain bounded multi-pair behavior. The existing aggregate candidate cap still applies.

The caller may pass `maxRootBytes` / `--max-root-bytes N`; the generic default is unbounded and deployment still enforces the complete Worker bundle budget. The experiment uses an explicit 460,964-byte root allowance alongside a 256 MiB total immutable storage cap. Both checks run before root publication. Construction scratch is excluded from uploaded index bytes.

`npx tsx scripts/build-pair-index.ts bench/generated/flp-100000/corpus.jsonl bench/generated/flp-100000/source work/global-100k work/pairs-fresh-inline 256 4096 --inline-rare --max-root-bytes 460964`

The completed fresh build is `work/pairs-100k-v4096-inline256`, generation `5f6dbb0357578758801c2a4c75f87d9ae30eabcaa03da7adb4d3471dfd8a2a1b`. It contains 3,070,995 pairs: all 2,907,920 observed pairs with DF at most 16 (8,471,788 pair-document incidences), plus 163,075 utility-selected larger pairs. Construction took 487.6 seconds. Actual immutable storage is 125,980,936 bytes including a 151,816-byte root and 74,274,683 bytes of separate compressed postings; the remainder includes dictionary-embedded tiny lists, keys, descriptors, and physical padding. Although selected with a 256 MiB allowance, the published result occupies less than 128 MiB. Its binary root plus the existing heads-8 root totals 8,079,460 bytes, leaving 309,148 bytes within the unchanged 8 MiB index-data budget. Worker code and compressed deployment size are reported separately by Wrangler.

Coverage-only analysis (multi mode, no latency benchmark) reduces `on that advice appellant` from 1,401 unigram-intersection documents to 11 candidates (99.21%) and `and absent a showing` from 3,872 to 46 (98.81%). The advice phrase uses an inline anchor, so no separate pair-postings stage is needed. `absent a showing` falls from 3,873 to 783 (79.78%). These are necessary-condition supersets; full phrase alignment and original unigram scores remain authoritative. Counts are saved in `work/pairs-100k-v4096-inline256/coverage.jsonl`; native latency remains a separate measurement.

## Reproduction and validation

```sh
npx tsx scripts/build-pair-index.ts \
  bench/generated/flp-100000/corpus.jsonl \
  bench/generated/flp-100000/source work/global-100k \
  work/pairs-fresh 32 4096
node --import tsx scripts/analyze-pair-index.ts \
  bench/generated/flp-100000/source work/global-100k/bundle-heads-8.bin \
  work/pairs-fresh 'appellant contends' 'advice of counsel'
npm test -- tests/global-pairs.test.ts
npm run check
```

Dedicated tests cover binary inline/block entry versions, unknown-feature rejection, mixed inline/paged dictionary-only anchors, explicit root-cap failures without publication, Unicode NFKC/case normalization (CAFÉ / decomposed café / naïve / 東京), generation/checksum failures, repeated terms, title/body boundaries, separated pair occurrences that fail full phrase alignment, unknown-pair fallback, aggregate candidate caps, OR/NOT/EXCEPT/proximity, and identical IDs and original BM25 scores across two bundle budgets, all fields, and both positional execution modes.
