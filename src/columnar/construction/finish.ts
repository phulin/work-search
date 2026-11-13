import { crc32 } from "../../format/codec.js";
import { bm25 } from "../../query/engine.js";
import {
  BLOCK,
  PAGE,
  type Ref,
  type Root,
  type Branch,
  type Term,
  concat,
  u32,
  pack,
  unpack,
  encodeScores,
  encodeBranches,
  view,
} from "../format.js";
import {
  BuildStore,
  RunReader,
  type Run,
  type Cursor,
  jsonBytes,
  termHeader,
} from "./runs.js";
const zero: Ref = [0, 0, 0],
  SIZE = 8 * 1048576;
export const OBJECT_GROUP = 16384;
type Objects = Root["objects"];
export class ObjectStore {
  next: number;
  objects: Objects = [];
  constructor(
    readonly store: BuildStore,
    readonly base: number,
  ) {
    if (!Number.isInteger(base) || base < 0 || base > 0xffffffff)
      throw Error("Invalid construction object base");
    this.next = base;
  }
}
/** A small construction buffer; serving still addresses 256-KiB pages. Object
 * numbers are assigned before writing references, so no relocation pass exists. */
export class PackedWriter {
  buffer = new Uint8Array(SIZE);
  at = 0;
  object = -1;
  constructor(readonly target: ObjectStore) {}
  async put(data: Uint8Array): Promise<Ref> {
    if (!data.length || data.length > SIZE)
      throw Error("Invalid packed construction blob");
    let at = Math.ceil(this.at / 8) * 8;
    if (data.length <= PAGE && (at % PAGE) + data.length > PAGE)
      at = Math.ceil(at / PAGE) * PAGE;
    if (at + data.length > SIZE) {
      await this.flush();
      at = 0;
    }
    if (this.object < 0) {
      if (
        this.target.next >=
        (Math.floor(this.target.base / OBJECT_GROUP) + 1) * OBJECT_GROUP
      )
        throw Error("Construction object group exhausted");
      this.object = this.target.next++;
    }
    this.buffer.set(data, at);
    this.at = at + data.length;
    return [this.object, at, data.length];
  }
  async flush() {
    if (!this.at) return;
    const bytes = this.buffer.subarray(0, this.at),
      checksums: number[] = [];
    for (let p = 0; p < bytes.length; p += PAGE)
      checksums.push(crc32(bytes.subarray(p, p + PAGE)));
    const chunk = await this.target.store.put(bytes, "plan-0.bin");
    this.target.objects[this.object - this.target.base] = {
      name: `plan-${this.object}.bin`,
      key: chunk.key,
      size: chunk.size,
      sha256: chunk.sha256,
      checksums,
    };
    this.buffer.fill(0);
    this.at = 0;
    this.object = -1;
  }
}
type Fence = Root["dictionaries"][number];
export interface FinishState {
  cursor: Cursor;
  term?: {
    word: string;
    df: number;
    id: number;
    visited: number;
    levels: Branch[][];
  };
  nextTerm: number;
  entries: [string, Term][];
  dictionaries: Fence[][];
  ids: { entries: [string, number][]; dictionaries: Fence[][] };
  hot: [string, Term][];
  done?: boolean;
}
export interface Statistics {
  count: number;
  avgBody: number;
  avgTitle: number;
}
export interface TermRange {
  first: Cursor;
  end?: Cursor;
  firstTerm: number;
}
export function initialFinishState(range?: TermRange): FinishState {
  return {
    cursor: range?.first ?? { chunk: 0, at: 0 },
    nextTerm: range?.firstTerm ?? 1,
    entries: [],
    dictionaries: [[]],
    ids: { entries: [], dictionaries: [[]] },
    hot: [],
  };
}
export async function finishPostings(
  store: BuildStore,
  run: Run,
  stats: Statistics,
  objectBase: number,
  saved?: FinishState,
  byteBudget = 8 * 1048576,
  range?: TermRange,
) {
  const state: FinishState = saved
      ? structuredClone(saved)
      : initialFinishState(range),
    reader = new RunReader(store, run.chunks, state.cursor),
    objects = new ObjectStore(store, objectBase),
    scores = new PackedWriter(objects),
    positions = new PackedWriter(objects),
    plans = new PackedWriter(objects),
    idsLane = new PackedWriter(objects),
    started = performance.now();
  const parent = async (children: Branch[]): Promise<Branch> => ({
    first: children[0].first,
    last: children.at(-1)!.last,
    count: children.reduce((n, b) => n + b.count, 0),
    height: children[0].height + 1,
    b: Math.max(...children.map((b) => b.b)),
    t: Math.max(...children.map((b) => b.t)),
    score: await plans.put(encodeBranches(children)),
    positions: zero,
    locators: zero,
  });
  const push = async (b: Branch, level = 0): Promise<void> => {
    const list = (state.term!.levels[level] ??= []);
    list.push(b);
    if (list.length === 64) {
      const p = await parent(list);
      state.term!.levels[level] = [];
      await push(p, level + 1);
    }
  };
  const fenceParent = async (list: Fence[], lane = plans): Promise<Fence> => ({
    first: list[0].first,
    last: list.at(-1)!.last,
    ref: await lane.put(jsonBytes(list)),
  });
  const pushFence = async (
    f: Fence,
    level = 0,
    levels = state.dictionaries,
  ): Promise<void> => {
    const list = (levels[level] ??= []);
    list.push(f);
    if (list.length === 256) {
      const p = await fenceParent(
        list,
        levels === state.ids.dictionaries ? idsLane : plans,
      );
      levels[level] = [];
      await pushFence(p, level + 1, levels);
    }
  };
  const flushDictionary = async () => {
    if (!state.entries.length) return;
    await pushFence({
      first: state.entries[0][0],
      last: state.entries.at(-1)![0],
      ref: await plans.put(jsonBytes(state.entries)),
    });
    await pushFence(
      {
        first: state.ids.entries[0][0],
        last: state.ids.entries.at(-1)![0],
        ref: await idsLane.put(jsonBytes(state.ids.entries)),
      },
      0,
      state.ids.dictionaries,
    );
    state.entries = [];
    state.ids.entries = [];
  };
  let processed = 0;
  while (processed < byteBudget && performance.now() - started < 20000) {
    if (
      !state.term &&
      range?.end &&
      reader.cursor.chunk === range.end.chunk &&
      reader.cursor.at === range.end.at
    ) {
      state.done = true;
      break;
    }
    let record = await reader.peek();
    if (!state.term) {
      if (!record) {
        state.done = true;
        break;
      }
      const { word, df } = termHeader(record);
      if (!df) throw Error("Empty construction term");
      state.term = { word, df, id: state.nextTerm++, visited: 0, levels: [] };
      reader.consume(record);
      processed += record.length;
    }
    const docs: number[] = [],
      bf: number[] = [],
      tf: number[] = [],
      b: number[] = [],
      t: number[] = [],
      pos: Uint8Array[] = [],
      offsets = [0];
    while (docs.length < BLOCK) {
      record = await reader.peek();
      if (!record || view(record).getUint32(4, true) === 1) break;
      const v = view(record),
        doc = v.getUint32(8, true),
        bl = v.getUint32(12, true),
        tl = v.getUint32(16, true),
        bn = v.getUint32(20, true),
        tn = v.getUint32(24, true);
      // Long documents must not turn a nominal 128-posting leaf into an
      // unbounded positional buffer. A shorter exact leaf is equally valid.
      if (docs.length && offsets.at(-1)! + 4 + bn + tn > 4 * 1048576) break;
      if (
        v.getUint32(4, true) !== 2 ||
        record.length !== 28 + bn + tn ||
        doc >= stats.count ||
        (docs.length && doc <= docs.at(-1)!)
      )
        throw Error("Invalid final posting row");
      // Copy packed positions before releasing this source chunk.
      const bp = record.slice(28, 28 + bn),
        tp = record.slice(28 + bn),
        bc = view(bp).getUint32(0, true),
        tc = view(tp).getUint32(0, true);
      const packed = concat([u32([bn]), bp, tp]);
      pos.push(packed);
      offsets.push(offsets.at(-1)! + packed.length);
      docs.push(doc);
      bf.push(bc);
      tf.push(tc);
      b.push(bm25(bc, state.term.df, stats.count, bl, stats.avgBody));
      t.push(bm25(tc, state.term.df, stats.count, tl, stats.avgTitle));
      processed += record.length;
      reader.consume(record);
    }
    if (docs.length) {
      await push({
        first: docs[0],
        last: docs.at(-1)!,
        count: docs.length,
        height: 0,
        b: Math.max(...b),
        t: Math.max(...t),
        score: await scores.put(encodeScores(docs, bf, tf, b, t)),
        positions: await positions.put(
          concat([u32([docs.length]), u32(offsets), ...pos]),
        ),
        locators: zero,
      });
      state.term.visited += docs.length;
    }
    record = await reader.peek();
    if (!record || view(record).getUint32(4, true) === 1) {
      const term = state.term;
      if (term.visited !== term.df)
        throw Error("Final document frequency mismatch");
      for (let level = 0; level < term.levels.length - 1; level++)
        if (term.levels[level].length) {
          await push(await parent(term.levels[level]), level + 1);
          term.levels[level] = [];
        }
      const list = term.levels.at(-1)!,
        tree = list.length === 1 ? list[0] : await parent(list),
        plan: Term = { id: term.id, df: term.df, tree };
      state.entries.push([term.word, plan]);
      state.ids.entries.push([term.word, term.id]);
      if (state.entries.length === 256) await flushDictionary();
      if (state.hot.length < 256 || term.df >= state.hot.at(-1)![1].df) {
        state.hot.push([term.word, plan]);
        state.hot.sort((a, b) => b[1].df - a[1].df || (a[0] < b[0] ? -1 : 1));
        state.hot.length = Math.min(256, state.hot.length);
      }
      state.term = undefined;
    }
  }
  if (state.done) {
    await flushDictionary();
    for (const levels of [state.dictionaries, state.ids.dictionaries])
      for (let level = 0; level < levels.length - 1; level++)
        if (levels[level].length) {
          await pushFence(
            await fenceParent(
              levels[level],
              levels === state.ids.dictionaries ? idsLane : plans,
            ),
            level + 1,
            levels,
          );
          levels[level] = [];
        }
  }
  await scores.flush();
  await positions.flush();
  await plans.flush();
  await idsLane.flush();
  state.cursor = reader.cursor;
  return { state, objects: objects.objects, processed };
}
export interface Routing {
  dictionaries: Root["dictionaries"];
  dictionaryHeight: number;
  idRouting: Pick<Root, "dictionaries" | "dictionaryHeight">;
  hot: [string, Term][];
}
export function routingOf(state: FinishState): Routing {
  return {
    dictionaries: state.dictionaries.at(-1)!,
    dictionaryHeight: state.dictionaries.length - 1,
    idRouting: {
      dictionaries: state.ids.dictionaries.at(-1)!,
      dictionaryHeight: state.ids.dictionaries.length - 1,
    },
    hot: state.hot,
  };
}
export async function combineRouting(
  store: BuildStore,
  parts: Routing[],
  objectBase: number,
) {
  if (!parts.length || parts.length > 64)
    throw Error("Routing merge requires 1–64 ordered parts");
  const objects = new ObjectStore(store, objectBase),
    plans = new PackedWriter(objects);
  const combine = async (
    routes: Pick<Root, "dictionaries" | "dictionaryHeight">[],
  ) => {
    let height = Math.max(...routes.map((r) => r.dictionaryHeight ?? 0)),
      fences: Root["dictionaries"] = [];
    const parent = async (list: Root["dictionaries"]) => ({
      first: list[0].first,
      last: list.at(-1)!.last,
      ref: await plans.put(jsonBytes(list)),
    });
    for (const route of routes) {
      let list = route.dictionaries,
        h = route.dictionaryHeight ?? 0;
      if (!list.length) continue;
      while (h++ < height) list = [await parent(list)];
      fences.push(...list);
    }
    for (let i = 1; i < fences.length; i++)
      if (fences[i - 1].last >= fences[i].first)
        throw Error("Overlapping dictionary ranges");
    while (fences.length > 256) {
      const next = [];
      for (let at = 0; at < fences.length; at += 256)
        next.push(await parent(fences.slice(at, at + 256)));
      fences = next;
      height++;
    }
    return { dictionaries: fences, dictionaryHeight: height };
  };
  const routing = await combine(parts),
    idRouting = await combine(parts.map((p) => p.idRouting)),
    hot = parts
      .flatMap((p) => p.hot)
      .sort((a, b) => b[1].df - a[1].df || (a[0] < b[0] ? -1 : 1))
      .slice(0, 256);
  await plans.flush();
  return { routing: { ...routing, idRouting, hot }, objects: objects.objects };
}
