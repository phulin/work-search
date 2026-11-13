import { type Root, type Ref, pack, u32 } from "../format.js";
import { CorpusSource } from "./source.js";
import { BuildStore, jsonBytes } from "./runs.js";
import { ObjectStore, PackedWriter } from "./finish.js";
import { scanText } from "./text.js";
import type { Vocabulary } from "./vocabulary.js";

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
/** Revisit source bodies after lexical term IDs exist. Only one document and a
 * 320-token passage window are retained; source text is never staged locally. */
export async function finishDocuments(
  source: CorpusSource,
  store: BuildStore,
  root: Pick<Root, "generation" | "count">,
  vocabulary: Vocabulary,
  objectBase: number,
  saved?: DocumentState,
  tokenBudget = 1048576,
  range?: { first: number; end: number },
) {
  const state: DocumentState = saved
    ? structuredClone(saved)
    : { next: range?.first ?? 0, pending: [], documents: [] };
  const objects = new ObjectStore(store, objectBase),
    textLane = new PackedWriter(objects),
    planLane = new PackedWriter(objects),
    started = performance.now();
  let tokens = 0,
    processed = 0;
  const end = range?.end ?? root.count;
  if ((range?.first ?? 0) % 4096 || end > root.count || end < state.next)
    throw Error("Invalid document construction range");
  if (
    vocabulary.generation !== root.generation ||
    vocabulary.first > state.next ||
    vocabulary.end <= state.next ||
    vocabulary.end > root.count
  )
    throw Error("Document vocabulary coverage mismatch");
  const batchEnd = Math.min(end, vocabulary.end),
    ids = vocabulary.ids;
  let part = source.part(state.next),
    pointers = await source.pointers(
      state.next,
      Math.min(
        128,
        batchEnd - state.next,
        part.first + part.count - state.next,
      ),
    ),
    batchFirst = state.next;
  await source.prefetch(pointers);
  for (; state.next < batchEnd; state.next++) {
    if (state.next >= batchFirst + pointers.view.byteLength / 32) {
      part = source.part(state.next);
      batchFirst = state.next;
      pointers = await source.pointers(
        state.next,
        Math.min(
          128,
          batchEnd - state.next,
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
      scanned = scanText(doc.body);
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
      if (!ids.has(token.word))
        throw Error("Forward vocabulary missing a source token");
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
  if (state.next === end && state.pending.length) {
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
    dictionaryRequests: 0,
    dictionaryBytes: 0,
    done: state.next === end,
  };
}
