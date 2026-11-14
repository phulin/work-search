# Compact format implementation

This worktree replaces the serving encodings; it does not include a deployment.
The frozen local control is commit `3129497`. Its archived readers are required
only by the offline migration utility, never by serving code.

## Stored representation

- Score blocks contain document IDs, field frequencies, and packed field lengths.
  BM25 IDF is calculated once per query term. Batched numeric decoding calculates
  the original float64 formula into query workspaces. Float64 block upper bounds
  remain available for exact pruning; title boosts still apply at query time.
- Frequency packets no longer serialize a second document-ID handle column.
- Positional blocks share packed span offsets. Counts come from frequencies;
  empty fields use no payload, singletons use a varint, and longer position
  lists use a delta base plus packed gaps. Rows remain independently accessible.
- Document packages keep global forward token IDs and independently accessible
  statistics/display sections. Normalized text is stored once, in independently
  gzipped, nonoverlapping chunks with token checkpoints. The soft chunk target
  is 16,384 UTF-16 code units; boundaries never split tokens. Rendering scans
  the selected chunk and includes neighboring chunks when needed. JSON remains
  appropriate for the small arbitrary display metadata section.
- Pair context reuses field membership order, retaining occurrence positions and
  both neighboring global token IDs. It no longer stores duplicate document
  lists or fixed per-row directories. Memberships remain sorted lists.
- Pair packets are packed into 32 MiB containers. Bundled routing provides the
  container ID, offset, length, and pair count in 16 bytes per packet. Selected
  packets use direct R2 range reads and independent cache identities, with no
  remote directory step. Physical publication inventory deduplicates containers.

## Construction

Native postings finalization emits final complete-term packets directly from
sorted runs. Subsequent finalization only serializes term metadata; it does not
read and rewrite every score/position block. Construction writers target 32 MiB
objects and share a bounded buffer budget. No alternate legacy serving decoder
is retained. Old internal package and block magic values are rejected.

Automatic retirement/expiry of all construction staging objects is a separate,
still outstanding change. No lifecycle policy or Cloudflare resource has been
changed by this worktree.

## Validation status

Typechecking and all 93 columnar tests pass, including the local workerd/R2
construction test, exhaustive query references, fields, Boolean/positional
matching, score bands, ties, pagination, Unicode, and chunk-boundary excerpts.

A local 1M migration is in progress. The document migration encountered a source
JSON record boundary problem; full-corpus bytes and simulated latency results
are not yet available. Do not treat this commit as validated for adoption or as
a measured latency improvement. The migration utility loads old readers from an
explicit frozen checkout and writes only to a separate output directory.
