import { Reader, Memory, Lru } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import {
  decodeScores,
  encodeBranches,
  view,
  type Root,
  type Term,
  type Ref,
  type Branch,
} from "../format.js";
import { encodeTermPacket, type PacketBlock } from "../term-packet.js";
import { encodeDirectoryBlock, type DirectoryTerm } from "../term-directory.js";
import { ObjectStore, PackedWriter } from "./finish.js";
import type { BuildStore, Chunk } from "./runs.js";
interface ActiveTerm {
  word: string;
  id: number;
  df: number;
  visited: number;
  bodyOccurrences: number;
  titleOccurrences: number;
  stack: Branch[];
  levels: Branch[][];
  frequencyParts: Ref[];
  positions: Ref[];
}
export interface PacketTermState {
  fence: number;
  entry: number;
  term?: ActiveTerm;
  pending: [string, DirectoryTerm][];
  done?: boolean;
}
export async function finishPacketTerms(
  store: BuildStore,
  root: Root,
  fences: Root["dictionaries"],
  objectBase: number,
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
    objects = new ObjectStore(store, objectBase),
    frequencies = new PackedWriter(objects),
    positions = new PackedWriter(objects),
    plans = new PackedWriter(objects),
    blocks: { first: string; count: number; ref: Chunk }[] = [],
    started = performance.now();
  let pending: PacketBlock[] = [],
    positionRefs: Ref[] = [],
    pendingBytes = 24,
    completedTerms = 0,
    bodyOccurrences = 0,
    titleOccurrences = 0;
  const parent = async (list: Branch[]): Promise<Branch> => ({
    first: list[0].first,
    last: list.at(-1)!.last,
    count: list.reduce((n, b) => n + b.count, 0),
    height: list[0].height + 1,
    b: Math.max(...list.map((b) => b.b)),
    t: Math.max(...list.map((b) => b.t)),
    score: await plans.put(encodeBranches(list)),
    positions: [0, 0, 0],
    locators: [0, 0, 0],
  });
  const push = async (branch: Branch, level = 0): Promise<void> => {
    const levels = state.term!.levels;
    while (levels.length <= level) levels.push([]);
    levels[level].push(branch);
    if (levels[level].length === 64) {
      const p = await parent(levels[level]);
      levels[level] = [];
      await push(p, level + 1);
    }
  };
  const appendSpan = (list: Ref[], ref: Ref) => {
    const last = list.at(-1);
    if (last && last[0] === ref[0] && last[1] + last[2] <= ref[1])
      last[2] = ref[1] + ref[2] - last[1];
    else list.push([...ref]);
  };
  const flushFrequency = async () => {
    if (!pending.length) return;
    const packet = encodeTermPacket(state.term!.id, pending, positionRefs),
      ref = await frequencies.put(packet.frequencies),
      v = view(packet.frequencies),
      handles = v.getUint32(16, true);
    let row = 0;
    state.term!.frequencyParts.push(ref);
    for (let i = 0; i < pending.length; i++) {
      const old = pending[i].branch,
        p = 24 + i * 48;
      await push({
        ...old,
        score: [
          ref[0],
          ref[1] + v.getUint32(p + 12, true),
          v.getUint32(p + 16, true),
        ],
        positions: positionRefs[i],
        locators: [ref[0], ref[1] + handles + row * 4, old.count * 4],
      });
      row += old.count;
    }
    pending = [];
    positionRefs = [];
    pendingBytes = 24;
  };
  const flushDirectory = async () => {
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
  let entries: [string, Term][] | undefined,
    loadedFence = -1;
  while (!state.done) {
    if (!state.term) {
      if (state.fence >= fences.length) {
        state.done = true;
        break;
      }
      if (loadedFence !== state.fence) {
        entries = await reader.load(
          fences[state.fence].ref,
          (b) => JSON.parse(new TextDecoder().decode(b)) as [string, Term][],
          fences[state.fence].ref[2] * 4,
        );
        loadedFence = state.fence;
      }
      if (state.entry >= entries!.length) {
        state.fence++;
        state.entry = 0;
        continue;
      }
      const [word, term] = entries![state.entry++];
      state.term = {
        word,
        id: term.id,
        df: term.df,
        visited: 0,
        bodyOccurrences: 0,
        titleOccurrences: 0,
        stack: [term.tree],
        levels: [[]],
        frequencyParts: [],
        positions: [],
      };
    }
    const term = state.term;
    let leaf: Branch | undefined;
    while (term.stack.length) {
      const branch = term.stack.pop()!;
      if (!branch.height) {
        leaf = branch;
        break;
      }
      const children = await reader.branches(branch.score);
      for (let i = children.length - 1; i >= 0; i--)
        term.stack.push(children[i]);
    }
    if (!leaf) {
      await flushFrequency();
      if (term.visited !== term.df)
        throw Error("Packet term frequency mismatch");
      for (let level = 0; level < term.levels.length - 1; level++)
        if (term.levels[level].length) {
          const p = await parent(term.levels[level]);
          term.levels[level] = [];
          await push(p, level + 1);
        }
      const list = term.levels.at(-1)!;
      if (!list.length || !term.frequencyParts.length || !term.positions.length)
        throw Error("Empty packet term");
      const tree = list.length === 1 ? list[0] : await parent(list),
        [first, ...rest] = term.frequencyParts,
        [pos, ...extraPos] = term.positions;
      state.pending.push([
        term.word,
        {
          id: term.id,
          df: term.df,
          tree,
          frequencies: first,
          positional: pos,
          bodyOccurrences: term.bodyOccurrences,
          titleOccurrences: term.titleOccurrences,
          ...(rest.length ? { frequencyParts: rest } : {}),
          ...(extraPos.length ? { positionalParts: extraPos } : {}),
        },
      ]);
      completedTerms++;
      bodyOccurrences += term.bodyOccurrences;
      titleOccurrences += term.titleOccurrences;
      state.term = undefined;
      if (state.pending.length === 128) await flushDirectory();
    } else {
      const score = await reader.read(leaf.score),
        s = decodeScores(score);
      if (s.docs.length !== leaf.count)
        throw Error("Source packet leaf count mismatch");
      const needed = score.length + 48 + leaf.count * 4;
      if (pending.length && pendingBytes + needed > 4 * 1048576)
        await flushFrequency();
      const raw = await reader.read(leaf.positions),
        positionRef = await positions.put(raw);
      appendSpan(term.positions, positionRef);
      pending.push({
        branch: leaf,
        scores: Uint8Array.from(score),
        positions: new Uint8Array(),
      });
      positionRefs.push(positionRef);
      pendingBytes += needed;
      term.visited += leaf.count;
      term.bodyOccurrences += s.body.reduce((n, x) => n + x, 0);
      term.titleOccurrences += s.title.reduce((n, x) => n + x, 0);
    }
    if (
      reader.stats.bytes >= byteBudget ||
      performance.now() - started >= 30000
    )
      break;
  }
  await flushFrequency();
  if (state.done) await flushDirectory();
  await frequencies.flush();
  await positions.flush();
  await plans.flush();
  return {
    state,
    objects: objects.objects,
    blocks,
    completedTerms,
    bodyOccurrences,
    titleOccurrences,
    reads: reader.stats.requests,
    readBytes: reader.stats.bytes,
  };
}
