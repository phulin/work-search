import type { Root } from "../format.js";
import { loadDictionary } from "../dictionary.js";
import { Reader, Memory, Lru } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import { CorpusSource } from "./source.js";
import { BuildStore, jsonBytes } from "./runs.js";
import { scanText } from "./text.js";
export interface VocabularyRoot extends Pick<
  Root,
  "generation" | "count" | "objects" | "objectIds"
> {
  idRouting: Pick<Root, "dictionaries" | "dictionaryHeight">;
}
export interface Vocabulary {
  generation: string;
  first: number;
  end: number;
  ids: Map<string, number>;
}
export async function buildVocabulary(
  source: CorpusSource,
  store: BuildStore,
  root: VocabularyRoot,
  first: number,
  count: number,
) {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024 ||
    first < 0 ||
    first + count > root.count
  )
    throw Error("Invalid vocabulary range");
  const words = new Set<string>(),
    started = performance.now();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  let next = first,
    tokens = 0;
  for (; next < first + count;) {
    const part = source.part(next),
      pointers = await source.pointers(
        next,
        Math.min(128, first + count - next, part.first + part.count - next),
      ),
      batchFirst = next;
    await source.prefetch(pointers);
    for (; next < batchFirst + pointers.view.byteLength / 32; next++) {
      const doc = await source.document(next, pointers, next - batchFirst);
      for (const token of scanText(doc.body).tokens()) {
        if (!words.has(token.word))
          words.add(decoder.decode(encoder.encode(token.word)));
        tokens++;
      }
      if (
        tokens >= 2000000 ||
        words.size >= 100000 ||
        performance.now() - started > 20000
      ) {
        next++;
        break;
      }
    }
    if (
      tokens >= 2000000 ||
      words.size >= 100000 ||
      performance.now() - started > 20000
    )
      break;
  }
  const memory = new Memory();
  memory.pages = new Lru(4 * 1048576);
  memory.decoded = new Lru(2 * 1048576);
  const reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    names = [...words].sort(),
    ids = new Map<string, number>();
  for (let at = 0; at < names.length; at += 4096) {
    const found = await loadDictionary<number>(
      names.slice(at, at + 4096),
      reader,
      { ...root.idRouting, hot: {} },
    );
    for (const [word, id] of found) ids.set(word, id);
  }
  if (ids.size !== names.length)
    throw Error("Source vocabulary missing from global dictionary");
  const bytes = new Uint8Array(
    await new Response(
      new Response(
        jsonBytes({
          generation: root.generation,
          first,
          end: next,
          ids: names.map((word) => [word, ids.get(word)!]),
        }) as BodyInit,
      ).body!.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  return {
    first,
    end: next,
    words: names.length,
    tokens,
    vocabulary: await store.put(bytes),
    dictionaryRequests: reader.stats.requests,
    dictionaryBytes: reader.stats.bytes,
  };
}
export async function readVocabulary(
  store: BuildStore,
  ref: Parameters<BuildStore["get"]>[0],
): Promise<Vocabulary> {
  const bytes = await store.get(ref),
    value = await new Response(
      new Response(bytes as BodyInit).body!.pipeThrough(
        new DecompressionStream("gzip"),
      ),
    ).json<any>();
  if (
    !/^[a-f0-9]{64}$/.test(value.generation) ||
    !Number.isInteger(value.first) ||
    !Number.isInteger(value.end) ||
    value.first < 0 ||
    value.end <= value.first ||
    !Array.isArray(value.ids) ||
    value.ids.some(
      (e: any) =>
        !Array.isArray(e) ||
        e.length !== 2 ||
        typeof e[0] !== "string" ||
        !Number.isInteger(e[1]) ||
        e[1] < 0 ||
        e[1] > 0xffffffff,
    )
  )
    throw Error("Invalid range vocabulary");
  const ids = new Map<string, number>(value.ids);
  if (ids.size !== value.ids.length)
    throw Error("Duplicate range vocabulary word");
  return { ...value, ids };
}
