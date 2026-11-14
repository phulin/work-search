/** A request-scoped filter over internal document IDs. Preparation may read
 * metadata in batches; the returned predicate must be synchronous and valid
 * for every ID in that batch. Preparations may overlap across windows. Rejection never changes text scoring statistics. */
export interface DocumentFilter {
  prepare(documents: Uint32Array): Promise<(doc: number) => boolean>;
}
export interface FilterCounters {
  metadataFilterCandidates: number;
  metadataFilterRejected: number;
}
export async function filterDocuments(
  documents: Uint32Array,
  filter: DocumentFilter | undefined,
  counters: FilterCounters,
) {
  if (!filter || !documents.length) return documents;
  const accepts = await filter.prepare(documents),
    selected = new Uint32Array(documents.length);
  let n = 0;
  for (const doc of documents) if (accepts(doc)) selected[n++] = doc;
  counters.metadataFilterCandidates += documents.length;
  counters.metadataFilterRejected += documents.length - n;
  return selected.subarray(0, n);
}
/** Bounded candidate batches, including complement/all-document queries. */
export async function* filteredDocumentBatches(
  documents: Iterable<number>,
  filter: DocumentFilter | undefined,
  counters: FilterCounters,
) {
  if (!filter) {
    yield documents;
    return;
  }
  let batch = new Uint32Array(4096),
    n = 0;
  for (const doc of documents) {
    batch[n++] = doc;
    if (n === batch.length) {
      yield await filterDocuments(batch, filter, counters);
      batch = new Uint32Array(4096);
      n = 0;
    }
  }
  if (n) yield await filterDocuments(batch.subarray(0, n), filter, counters);
}
