import { Reader, Memory, Lru } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import type { Root } from "../format.js";
import { encodeDirectoryBlock, type DirectoryTerm } from "../term-directory.js";
import type { BuildStore, Chunk } from "./runs.js";
export interface PacketTermState {
  fence: number;
  entry: number;
  pending: [string, DirectoryTerm][];
  done?: boolean;
}
/** Postings finalization already wrote complete term packets. This pass only
 * emits bounded metadata groups for bundle/cold-shard selection; it never
 * copies score or positional payloads into a second serving representation. */
export async function finishPacketTerms(
  store: BuildStore,
  root: Root,
  fences: Root["dictionaries"],
  _objectBase: number,
  saved?: PacketTermState,
  byteBudget = 64 * 1048576,
) {
  if (!fences.length || fences.length > 16)
    throw Error("Packet jobs require 1–16 dictionary leaves");
  const state: PacketTermState = saved
      ? structuredClone(saved)
      : { fence: 0, entry: 0, pending: [] },
    memory = new Memory();
  memory.pages = new Lru(4 * 1048576);
  memory.decoded = new Lru(2 * 1048576);
  const reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    blocks: { first: string; count: number; ref: Chunk }[] = [],
    dfCounts = new Map<number, number>(),
    started = performance.now();
  let completedTerms = 0,
    bodyOccurrences = 0,
    titleOccurrences = 0;
  const flush = async () => {
    if (!state.pending.length) return;
    const raw = encodeDirectoryBlock(state.pending),
      compressed = new Uint8Array(
        await new Response(
          new Response(raw as BodyInit).body!.pipeThrough(
            new CompressionStream("gzip"),
          ),
        ).arrayBuffer(),
      );
    blocks.push({
      first: state.pending[0][0],
      count: state.pending.length,
      ref: await store.put(compressed),
    });
    state.pending = [];
  };
  while (state.fence < fences.length) {
    const fence = fences[state.fence],
      entries = await reader.load(
        fence.ref,
        (b) =>
          JSON.parse(new TextDecoder().decode(b)) as [string, DirectoryTerm][],
        fence.ref[2] * 4,
      );
    while (state.entry < entries.length) {
      const [word, term] = entries[state.entry++];
      if (!term.frequencies || !term.positional)
        throw Error("Construction term lacks direct packet addresses");
      state.pending.push([word, term]);
      completedTerms++;
      bodyOccurrences += term.bodyOccurrences;
      titleOccurrences += term.titleOccurrences;
      dfCounts.set(term.df, (dfCounts.get(term.df) ?? 0) + 1);
      if (state.pending.length === 128) await flush();
    }
    state.entry = 0;
    state.fence++;
    if (reader.stats.bytes >= byteBudget || performance.now() - started > 20000)
      break;
  }
  if (state.fence === fences.length) {
    state.done = true;
    await flush();
  }
  return {
    state,
    objects: [] as Root["objects"],
    blocks,
    completedTerms,
    dfCounts: [...dfCounts],
    bodyOccurrences,
    titleOccurrences,
    reads: reader.stats.requests,
    readBytes: reader.stats.bytes,
  };
}
