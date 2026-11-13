import { encodeDocumentPackage } from "../document-package.js";
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
  vocabulary: Vocabulary,
  generation: string,
  first: number,
  count: number,
  sink?: (doc: number, packet: Uint8Array) => Promise<void>,
) {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024 ||
    first < vocabulary.first ||
    first >= vocabulary.end ||
    vocabulary.generation !== root.generation
  )
    throw Error("Invalid document package range");
  const end = Math.min(first + count, vocabulary.end),
    ids = new Map(vocabulary.ids),
    memory = new Memory();
  memory.pages = new Lru(4 * 1048576);
  memory.decoded = new Lru(2 * 1048576);
  const reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    started = performance.now();
  let next = first,
    tokens = 0,
    bytes = 0;
  const writes = new Set<Promise<void>>();
  let writeError: unknown;
  let part = source.part(next),
    batchFirst = next,
    pointers = await source.pointers(
      next,
      Math.min(128, end - next, part.first + part.count - next),
    );
  await source.prefetch(pointers);
  for (; next < end; next++) {
    if (next >= batchFirst + pointers.view.byteLength / 32) {
      part = source.part(next);
      batchFirst = next;
      pointers = await source.pointers(
        next,
        Math.min(128, end - next, part.first + part.count - next),
      );
      await source.prefetch(pointers);
    }
    const doc = await source.document(next, pointers, next - batchFirst),
      missing = [
        ...new Set(
          [...scanText(doc.title ?? "").tokens()]
            .map((t) => t.word)
            .filter((word) => !ids.has(word)),
        ),
      ];
    if (missing.length) {
      const found = await loadDictionary<number>(missing, reader, {
        ...root.idRouting,
        hot: {},
      });
      for (const [word, id] of found) ids.set(word, id);
      if (found.size !== missing.length)
        throw Error("Title token missing from global directory");
    }
    const packet = await encodeDocumentPackage({ ...doc, doc: next }, ids);
    while (writes.size >= 4) await Promise.race(writes);
    if (writeError) throw writeError;
    const write = (
      sink
        ? sink(next, packet)
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
    if (tokens >= 1048576 || performance.now() - started >= 15000) {
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
    generation,
    dictionaryRequests: reader.stats.requests,
    dictionaryBytes: reader.stats.bytes,
  };
}
