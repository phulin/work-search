# Storage formats

The default search format is `CWS1`, defined by `Root` in
`src/columnar/format.ts`. A root binds corpus statistics, analysis, term and
object directories, and optional pair/document/metadata data to one generation.
The serving engine verifies generation consistency before combining assets.

## Objects and references

A `Ref` is `[objectId, byteOffset, byteLength]`. Roots enumerate immutable objects
with sizes and SHA-256 identities. Optional sorted logical object IDs permit
parallel producers to reserve disjoint address spaces. Construction containers
use the `OBJECT` constant (32 MiB); `PAGE` is 256 KiB and `BLOCK` is 128 postings.
Objects, cache pages, decoding blocks, and request ranges are independent units.

`storage.ts` batches and coalesces range reads. `r2.ts` checks object metadata;
readers validate supplied checksums and retain generation-scoped immutable
pages. `compact-integers.ts` and `format.ts` provide bounded integer and reference
codecs used by postings and directories.

## Terms and postings

`term-directory.ts` encodes common-term metadata in front-coded groups and
bundles cold-term routing. `term-shard.ts` stores remote descriptors and small
complete packets together. A descriptor contains the term's numeric ID,
document frequency, field occurrence counts, frequency/position references,
and block-tree root. Larger streams can have multiple contiguous parts.

`term-packet.ts` stores sorted document IDs, field frequencies, exact body/title
score contributions, and numeric document handles. Positions have separate
streams and restartable offsets. `positions.ts` and `position-batches.ts` decode
only the spans needed by the selected execution path. Branch bounds support
exact block-max pruning; physical page reads do not force positional decoding.

## Documents

`document-package.ts` writes CDP4 records. Their 64-byte header addresses numeric
term blocks, frequencies, positions, compressed display metadata, a passage
directory, and compressed passages. Numeric and presentation ranges are disjoint.
`document-directory.ts` writes the bundled CDD2 locator directory, including
initial-read lengths and complete numeric-verification byte budgets.

Verification reads numeric data. Result rendering reads metadata and selected
passages for winners. Small result records can be fetched in one range without
changing the candidate-verification policy. See
[document verification](COLUMNAR-VERIFICATION.md).

## Pair membership and complete phrases

`pair-router.ts` routes normalized string pairs to immutable membership packets;
`pair-membership.ts` represents field-aware membership with sorted integer lists.
Context records retain occurrence positions and adjacent token IDs. External
context chunks have direct addresses and independently restartable encoding.

`exact-phrase-directory.ts` stores EPD2 bundled hot descriptors and EPR1 routed
extents. Descriptors bind complete context streams to the base search generation,
numeric term IDs, and field document/occurrence counts. A descriptor allocation
limits bundled metadata, not pair coverage. See
[complete phrase execution](EXACT-PHRASES.md).

## Metadata and presentation

`metadata-filter.ts` implements typed metadata columns and exact filtering.
Their immutable inventory and declared field types accompany the root.
`render.ts`, `text-chunks.ts`, and the content modules retrieve display metadata
and compressed passage text independently of numeric matching.

## Existing alternate formats

The other implemented formats remain defined alongside their readers:

| Modules                                            | Purpose                                                       |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `src/format/index.ts`, `documents.ts`, `blocks.ts` | Bundled index, compressed document tables, and posting blocks |
| `src/format/paged.ts`, `routes.ts`                 | Paged index roots and shard routes                            |
| `src/global/format.ts`, `pairs.ts`                 | Global paged index and selected pair data                     |
| `src/suffix/format.ts`                             | Suffix lookup data                                            |
| `src/content`                                      | Content packs, cards, metadata, and passages                  |

These formats are consumed by their own entry points and regression tests;
the default columnar Worker expects a matching columnar root and directories.
