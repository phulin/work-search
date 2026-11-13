import { type Root, type Ref, concat, pack, u32 } from "../format.js";
import { ColumnarIndex } from "../search.js";
import { Reader, Memory, Lru } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import { CorpusSource } from "./source.js";
import { BuildStore, jsonBytes } from "./runs.js";
import { ObjectStore, PackedWriter } from "./finish.js";
import { scanText } from "./text.js";

async function gzip(value: unknown) {
  return new Uint8Array(
    await new Response(
      new Response(jsonBytes(value) as BodyInit).body!.pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}
export interface DocumentState {
  next: number;
  pending: number[][];
  documents: Ref[];
}
export type ForwardRoot = Root & {
  idRouting: Pick<Root, "dictionaries" | "dictionaryHeight">;
};
/** Revisit source bodies after lexical term IDs exist. Only one document and a
 * 320-token passage window are retained; source text is never staged locally. */
export async function finishDocuments(
  source: CorpusSource,
  store: BuildStore,
  root: ForwardRoot,
  objectBase: number,
  saved?: DocumentState,
  tokenBudget = 1048576,
  idCache?: Lru<number>,
) {
  const state: DocumentState = saved
      ? structuredClone(saved)
      : { next: 0, pending: [], documents: [] },
    memory = new Memory();
  memory.pages = new Lru(4 * 1048576);
  memory.decoded = new Lru(2 * 1048576);
  const reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    index = new ColumnarIndex(root),
    objects = new ObjectStore(store, objectBase),
    textLane = new PackedWriter(objects),
    planLane = new PackedWriter(objects),
    started = performance.now();
  let tokens = 0,
    processed = 0,
    idHits = 0,
    idMisses = 0;
  let part = source.part(state.next),
    pointers = await source.pointers(
      state.next,
      Math.min(
        128,
        root.count - state.next,
        part.first + part.count - state.next,
      ),
    ),
    batchFirst = state.next;
  await source.prefetch(pointers);
  for (; state.next < root.count; state.next++) {
    if (state.next >= batchFirst + pointers.view.byteLength / 32) {
      part = source.part(state.next);
      batchFirst = state.next;
      pointers = await source.pointers(
        state.next,
        Math.min(
          128,
          root.count - state.next,
          part.first + part.count - state.next,
        ),
      );
      await source.prefetch(pointers);
    }
    const doc = await source.document(
        state.next,
        pointers,
        state.next - batchFirst,
      ),
      scanned = scanText(doc.body),
      words = new Set<string>(),
      ids = new Map(
        Object.entries(root.hot).map(([word, term]) => [word, term.id]),
      );
    for (const token of scanned.tokens()) words.add(token.word);
    const names = [...words].filter((word) => {
      if (ids.has(word)) return false;
      const cached = idCache?.get(word);
      if (cached !== undefined) {
        ids.set(word, cached);
        idHits++;
        return false;
      }
      idMisses++;
      return true;
    });
    // Resolving in batches also bounds the set of concurrently loaded plans.
    for (let at = 0; at < names.length; at += 512) {
      const plans = await index.dictionary<number>(
        names.slice(at, at + 512),
        reader,
        {
          ...root.idRouting,
          hot: {},
        },
      );
      for (const [word, id] of plans) {
        ids.set(word, id);
        // Substrings from tokenization must not retain old source bodies.
        idCache?.set(
          new TextDecoder().decode(new TextEncoder().encode(word)),
          id,
          8,
        );
      }
    }
    if ([...words].some((word) => !ids.has(word)))
      throw Error("Forward vocabulary missing from final dictionary");
    const window: {
        word: string;
        position: number;
        start: number;
        end: number;
      }[] = [],
      directory: number[][] = [];
    let first = 0,
      lastPosition = -1;
    const flush = async (eof = false) => {
      const lo = Math.max(0, first - 32),
        hi = eof ? lastPosition + 1 : first + 288;
      const entries = window.filter((t) => t.position >= lo && t.position < hi),
        start = entries[0]?.start ?? 0,
        end = entries.at(-1)?.end ?? scanned.text.length;
      const tokenRef = await textLane.put(
          pack(entries.map((t) => ids.get(t.word)!)),
        ),
        snippetRef = await textLane.put(
          await gzip({
            first: lo,
            text: scanned.text.slice(start, end),
            starts: entries.map((t) => t.start - start),
            ends: entries.map((t) => t.end - start),
          }),
        );
      directory.push([lo, entries.length, ...tokenRef, ...snippetRef]);
      first += 256;
      while (window.length && window[0].position < first - 32) window.shift();
    };
    for (const token of scanned.tokens()) {
      lastPosition = token.position;
      window.push(token);
      if (token.position === first + 287) await flush();
    }
    // Frame 0 exists even for an empty body. Each subsequent frame corresponds
    // to a token position / 256, including an overlap-only short final frame.
    while (first < Math.max(1, lastPosition + 1)) await flush(true);
    const record = await textLane.put(
        await gzip({
          id: doc.id,
          title: doc.title,
          metadata: doc.metadata,
          preview: scanned.text.slice(0, 400),
        }),
      ),
      forward = await planLane.put(u32(directory.flat())),
      head = directory[0].slice(5, 8);
    state.pending.push([...record, ...forward, ...head]);
    if (state.pending.length === 4096) {
      state.documents.push(await planLane.put(u32(state.pending.flat())));
      state.pending = [];
    }
    tokens += lastPosition + 1;
    processed++;
    if (
      tokens >= tokenBudget ||
      processed >= 1024 ||
      performance.now() - started > 15000
    ) {
      state.next++;
      break;
    }
  }
  if (state.next === root.count && state.pending.length) {
    state.documents.push(await planLane.put(u32(state.pending.flat())));
    state.pending = [];
  }
  await textLane.flush();
  await planLane.flush();
  return {
    state,
    objects: objects.objects,
    tokens,
    processed,
    dictionaryRequests: reader.stats.requests,
    dictionaryBytes: reader.stats.bytes,
    idHits,
    idMisses,
    idCacheBytes: idCache?.bytes ?? 0,
    done: state.next === root.count,
  };
}
