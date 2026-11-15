import { encodeAnalyzedDocumentPackage } from "../document-package.js";
import {
  analyzeDocument,
  resolveDocument,
  type AnalyzedDocument,
  type NumericDocument,
} from "./analyzed-document.js";
import { Reader, Lru, Memory } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import { loadDictionary } from "../dictionary.js";
import type { Vocabulary, VocabularyRoot } from "./vocabulary.js";
import type { CorpusSource } from "./source.js";
import type { BuildStore } from "./runs.js";
import { scanText } from "./text.js";
export async function finishPackageDocuments(
  source: CorpusSource,
  store: BuildStore,
  root: VocabularyRoot,
  vocabulary: Vocabulary | undefined,
  generation: string,
  first: number,
  count: number,
  sink?: (doc: number, packet: Uint8Array) => Promise<void | boolean>,
  tokenBudget = 1048576,
  lookup?: {
    lookup(names: string[]): Promise<Map<string, number>>;
    stats: { requests: number; bytes: number; hits: number; misses: number };
  },
  numericSink?: (document: NumericDocument) => Promise<void>,
) {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024 ||
    first < 0 ||
    first >= root.count ||
    (!vocabulary && !lookup) ||
    (vocabulary &&
      (first < vocabulary.first ||
        first >= vocabulary.end ||
        vocabulary.generation !== root.generation))
  )
    throw Error("Invalid document package range");
  const end = Math.min(first + count, vocabulary?.end ?? root.count),
    ids = new Map(vocabulary?.ids),
    memory = new Memory();
  memory.pages = new Lru(4 * 1048576);
  memory.decoded = new Lru(2 * 1048576);
  const reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    started = performance.now();
  let next = first,
    tokens = 0,
    bytes = 0;
  let verificationBytes = 0;
  const writes = new Set<Promise<void>>();
  let writeError: unknown;
  let part = source.part(next),
    batchFirst = next,
    pointers = await source.pointers(
      next,
      Math.min(128, end - next, part.first + part.count - next),
    );
  await source.prefetch(pointers);
  let batch: AnalyzedDocument[] = [],
    batchAt = 0;
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  async function readBatch() {
    batch = [];
    batchAt = 0;
    let analyzedBytes = 0,
      batchTokens = 0;
    const missing = new Set<string>();
    for (let doc = next; doc < end && batch.length < 128; doc++) {
      if (doc >= batchFirst + pointers.view.byteLength / 32) {
        part = source.part(doc);
        batchFirst = doc;
        pointers = await source.pointers(
          doc,
          Math.min(128, end - doc, part.first + part.count - doc),
        );
        await source.prefetch(pointers);
      }
      const value = await source.document(doc, pointers, doc - batchFirst);
      const analyzed = analyzeDocument({ ...value, doc }, root.analysis);
      batch.push(analyzed);
      analyzedBytes += analyzed.retainedBytes;
      batchTokens += analyzed.body.length + analyzed.title.length;
      for (const word of analyzed.words) if (!ids.has(word)) missing.add(word);
      if (
        analyzedBytes >= 8 * 1048576 ||
        batchTokens >= Math.min(262144, tokenBudget - tokens) ||
        missing.size >= 100000
      )
        break;
    }
    if (missing.size) {
      const names = [...missing].sort(),
        found = lookup
          ? await lookup.lookup(names)
          : await loadDictionary<number>(names, reader, {
              ...root.idRouting,
              hot: {},
            });
      if (found.size !== names.length)
        throw Error("Document token missing from global directory");
      for (const [word, id] of found) ids.set(word, id);
    }
  }
  for (; next < end; next++) {
    if (batchAt === batch.length) await readBatch();
    const doc = batch[batchAt++],
      numeric = resolveDocument(doc, ids);
    const packet = await encodeAnalyzedDocumentPackage(doc, numeric);
    if (sink && (await sink(next, packet)) === false) break;
    await numericSink?.(numeric);
    while (writes.size >= 4) await Promise.race(writes);
    if (writeError) throw writeError;
    const write = (
      sink
        ? Promise.resolve()
        : store.putNamed(generation, `plan-${next}.bin`, packet)
    )
      .then(
        () => {},
        (error) => {
          writeError = error;
        },
      )
      .finally(() => writes.delete(write));
    writes.add(write);
    tokens += new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength,
    ).getUint32(8, true);
    bytes += packet.length;
    verificationBytes += new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength,
    ).getUint32(16, true);
    if (tokens >= tokenBudget || performance.now() - started >= 15000) {
      next++;
      break;
    }
  }
  await Promise.all(writes);
  if (writeError) throw writeError;
  return {
    first,
    end: next,
    documents: next - first,
    tokens,
    bytes,
    verificationBytes,
    generation,
    dictionaryRequests: reader.stats.requests + (lookup?.stats.requests ?? 0),
    dictionaryBytes: reader.stats.bytes + (lookup?.stats.bytes ?? 0),
    idHits: lookup?.stats.hits ?? 0,
    idMisses: lookup?.stats.misses ?? 0,
  };
}
