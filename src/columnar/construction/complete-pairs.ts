import { concat, u32, view } from "../format.js";
import {
  mergePairPackets,
  PairPacket,
  type PairColumnRow,
} from "../pair-packet.js";
import {
  pairPositionChunks,
  encodePairPositionDirectory,
  type PairPositionChunk,
} from "../pair-positions.js";
import {
  encodePairMembership,
  encodePairMembershipPacket,
  pairStringHash,
  pairHash,
} from "../pair-membership.js";
import { BuildStore, digest, type Chunk } from "./runs.js";
import { StagingContainer } from "./staging-container.js";
import { transformBlock } from "./block-codec.js";
import type { AnalyzedDocument, NumericDocument } from "./analyzed-document.js";

export interface CompletePairRun {
  version: 1;
  catalogue: string;
  first: number;
  end: number;
  chunks: (Chunk & { firstHash: number })[];
  occurrences: number;
}
export interface PairCursor {
  chunk: number;
  at: number;
}
interface Record {
  a: string;
  b: string;
  h: number;
  h2: number;
  packet: Uint8Array;
  raw: Uint8Array;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const PRESENCE = "\u0001";
export function pairRouteHashes(a: string, b: string) {
  return [
    pairHash(pairStringHash(a), pairStringHash(b)),
    pairHash(pairStringHash("!" + a), pairStringHash("!" + b)),
  ] as const;
}
function record(a: string, b: string, packet: Uint8Array) {
  const x = encoder.encode(a),
    y = encoder.encode(b),
    [h, h2] = pairRouteHashes(a, b);
  return concat([
    u32([
      24 + x.length + y.length + packet.length,
      x.length,
      y.length,
      packet.length,
      h,
      h2,
    ]),
    x,
    y,
    packet,
  ]);
}
function read(raw: Uint8Array, at: number): Record {
  const v = view(raw),
    n = v.getUint32(at, true),
    x = v.getUint32(at + 4, true),
    y = v.getUint32(at + 8, true),
    p = v.getUint32(at + 12, true);
  if (n !== 24 + x + y + p || at + n > raw.length || !x || !y)
    throw Error("Invalid complete pair record");
  return {
    a: decoder.decode(raw.subarray(at + 24, at + 24 + x)),
    b: decoder.decode(raw.subarray(at + 24 + x, at + 24 + x + y)),
    h: v.getUint32(at + 16, true),
    h2: v.getUint32(at + 20, true),
    packet: raw.subarray(at + 24 + x + y, at + n),
    raw: raw.subarray(at, at + n),
  };
}
function compare(a: Record, b: Record) {
  return (
    a.h - b.h ||
    a.h2 - b.h2 ||
    (a.a < b.a ? -1 : a.a > b.a ? 1 : a.b < b.b ? -1 : a.b > b.b ? 1 : 0)
  );
}
class RunWriter {
  chunks: CompletePairRun["chunks"] = [];
  parts: Uint8Array[] = [];
  bytes = 0;
  firstHash = 0;
  constructor(readonly physical: StagingContainer) {}
  async append(raw: Uint8Array) {
    if (this.bytes && this.bytes + raw.length > 262144) await this.flush();
    if (!this.bytes) this.firstHash = view(raw).getUint32(16, true);
    this.parts.push(raw);
    this.bytes += raw.length;
  }
  async flush() {
    if (!this.bytes) return;
    const ref = await this.physical.append(
      await transformBlock(concat(this.parts)),
    );
    this.chunks.push(Object.assign(ref, { firstHash: this.firstHash }));
    this.parts = [];
    this.bytes = 0;
  }
}
/** Every adjacent occurrence is retained, including common words and rare words.
 * Strings are stored once per short pair span, not once per token occurrence. */
export class CompletePairWriter {
  runs: CompletePairRun[] = [];
  private groups = new Map<
    string,
    { a: string; b: string; idA: number; idB: number; rows: PairColumnRow[] }
  >();
  private tokens = 0;
  private occurrences = 0;
  private next: number;
  private first: number;
  private physical: StagingContainer;
  constructor(
    readonly store: BuildStore,
    first: number,
    readonly catalogue: string,
    readonly commonIds: ReadonlySet<number> = new Set(),
  ) {
    this.first = this.next = first;
    this.physical = new StagingContainer(store, 16 * 1048576);
  }
  async append(
    doc: NumericDocument,
    analyzed: AnalyzedDocument,
    ids: Map<string, number>,
  ) {
    if (doc.doc !== this.next++)
      throw Error("Complete pair document coverage gap");
    const names = new Map(analyzed.words.map((w) => [ids.get(w)!, w]));
    const empty = () => ({
      positions: [] as number[],
      previous: [] as number[],
      next: [] as number[],
    });
    for (const [field, tokens] of [doc.body, doc.title].entries()) {
      this.tokens += tokens.length;
      this.occurrences += Math.max(0, tokens.length - 1);
      for (let p = 1; p < tokens.length; p++) {
        const idA = tokens[p - 1],
          idB = tokens[p],
          a = names.get(idA),
          b = names.get(idB);
        if (a === undefined || b === undefined)
          throw Error("Missing complete pair word");
        const key = a + "\0" + b;
        let group = this.groups.get(key);
        if (!group) {
          group = { a, b, idA, idB, rows: [] };
          this.groups.set(key, group);
        }
        let row = group.rows.at(-1);
        if (row?.doc !== doc.doc) {
          row = { doc: doc.doc, body: empty(), title: empty() };
          group.rows.push(row);
        }
        const col = field ? row.title : row.body;
        (col.positions as number[]).push(p - 1);
        (col.previous as number[]).push(p > 1 ? tokens[p - 2] + 1 : 0);
        (col.next as number[]).push(
          p + 1 < tokens.length ? tokens[p + 1] + 1 : 0,
        );
      }
      const present = new Set<number>();
      for (const id of tokens) if (this.commonIds.has(id)) present.add(id);
      for (const id of present) {
        const a = names.get(id)!,
          key = a + "\0" + PRESENCE;
        let group = this.groups.get(key);
        if (!group) {
          group = { a, b: PRESENCE, idA: id, idB: id, rows: [] };
          this.groups.set(key, group);
        }
        let row = group.rows.at(-1);
        if (row?.doc !== doc.doc) {
          row = { doc: doc.doc, body: empty(), title: empty() };
          group.rows.push(row);
        }
        const column = field ? row.title : row.body;
        (column.positions as number[]).push(0);
        (column.previous as number[]).push(0);
        (column.next as number[]).push(0);
      }
    }
    if (this.tokens >= 65536) await this.flush();
  }
  private async flush() {
    if (this.first === this.next) return;
    const sorted = [...this.groups.values()].map((g) => ({
      ...g,
      h: pairRouteHashes(g.a, g.b),
    }));
    sorted.sort(
      (a, b) =>
        a.h[0] - b.h[0] ||
        a.h[1] - b.h[1] ||
        (a.a < b.a ? -1 : a.a > b.a ? 1 : a.b < b.b ? -1 : 1),
    );
    const writer = new RunWriter(this.physical);
    for (const g of sorted)
      for (const chunk of pairPositionChunks(g.idA, g.idB, g.rows))
        await writer.append(record(g.a, g.b, chunk.data));
    await writer.flush();
    this.runs.push({
      version: 1,
      catalogue: this.catalogue,
      first: this.first,
      end: this.next,
      chunks: writer.chunks,
      occurrences: this.occurrences,
    });
    this.groups.clear();
    this.tokens = this.occurrences = 0;
    this.first = this.next;
  }
  async finish() {
    await this.flush();
    await this.physical.flush();
    return this.runs;
  }
}
class Cursor {
  bytes?: Uint8Array;
  private window = new Map<number, Uint8Array>();
  state: PairCursor;
  constructor(
    readonly store: BuildStore,
    readonly run: CompletePairRun,
    state?: PairCursor,
    readonly range?: { first: number; end: number },
  ) {
    this.state = state ? { ...state } : { chunk: 0, at: 0 };
    if (!state && range && range.first > 0) {
      let lo = 0,
        hi = run.chunks.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (run.chunks[m].firstHash < range.first) lo = m + 1;
        else hi = m;
      }
      this.state.chunk = Math.max(0, lo - 1);
    }
  }
  async head() {
    while (this.state.chunk < this.run.chunks.length) {
      if (!this.bytes) {
        const at = this.state.chunk;
        if (!this.window.has(at)) {
          let end = at + 1,
            bytes = this.run.chunks[at].size;
          while (
            end < this.run.chunks.length &&
            this.run.chunks[end].key === this.run.chunks[at].key &&
            bytes + this.run.chunks[end].size <= 262144
          )
            bytes += this.run.chunks[end++].size;
          const blocks = await this.store.getMany(
            this.run.chunks.slice(at, end),
            262144,
          );
          blocks.forEach((raw, i) => this.window.set(at + i, raw));
        }
        this.bytes = await transformBlock(this.window.get(at)!, true);
        this.window.delete(at);
      }
      if (this.state.at === this.bytes.length) {
        this.bytes = undefined;
        this.state.chunk++;
        this.state.at = 0;
        continue;
      }
      if (this.state.at > this.bytes.length)
        throw Error("Invalid complete pair continuation");
      const r = read(this.bytes, this.state.at);
      if (this.range && r.h < this.range.first) {
        this.take(r);
        continue;
      }
      if (this.range && r.h >= this.range.end) return;
      return r;
    }
  }
  take(r: Record) {
    this.state.at += r.raw.length;
  }
}
export async function mergeCompletePairs(
  store: BuildStore,
  runs: CompletePairRun[],
  saved?: { cursors: PairCursor[] },
  budget = 64 * 1048576,
  range?: { first: number; end: number },
) {
  if (
    !runs.length ||
    runs.length > 16 ||
    runs.some(
      (r, i) =>
        r.version !== 1 ||
        r.catalogue !== runs[0].catalogue ||
        (i > 0 && runs[i - 1].end !== r.first),
    ) ||
    (saved && saved.cursors.length !== runs.length)
  )
    throw Error("Invalid complete pair merge coverage");
  if (
    range &&
    (!Number.isInteger(range.first) ||
      !Number.isInteger(range.end) ||
      range.first < 0 ||
      range.end > 2 ** 32 ||
      range.end <= range.first)
  )
    throw Error("Invalid complete pair hash range");
  const cursors = runs.map(
      (r, i) => new Cursor(store, r, saved?.cursors[i], range),
    ),
    heads = await Promise.all(cursors.map((c) => c.head())),
    physical = new StagingContainer(store, 16 * 1048576),
    writer = new RunWriter(physical);
  let bytes = 0;
  for (;;) {
    let selected = -1;
    heads.forEach((h, i) => {
      if (h && (selected < 0 || compare(h, heads[selected]!) < 0)) selected = i;
    });
    if (selected < 0 || bytes >= budget) break;
    const h = heads[selected]!;
    await writer.append(h.raw);
    bytes += h.raw.length;
    cursors[selected].take(h);
    heads[selected] = await cursors[selected].head();
  }
  await writer.flush();
  await physical.flush();
  return {
    chunks: writer.chunks,
    state: {
      cursors: cursors.map((c) => c.state),
      done: heads.every((h) => !h),
    },
    bytes,
  };
}

export interface CompletePairLeaf {
  h: number;
  h2: number;
  object: number;
  offset: number;
  bytes: number;
  pairs: number;
}
/** Final objects contain many independently addressed packets/chunks. A task
 * retains one pair's membership arrays and a bounded output container. */
class ServingWriter {
  objects: { id: number; key: string; size: number; sha256: string }[] = [];
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private id: number;
  constructor(
    readonly store: BuildStore,
    readonly generation: string,
    readonly kind: "pairs" | "positions",
    base: number,
  ) {
    this.id = base;
  }
  async append(raw: Uint8Array) {
    if (this.bytes && this.bytes + raw.length > 16 * 1048576)
      await this.flush();
    const ref = { object: this.id, offset: this.bytes, length: raw.length };
    this.parts.push(raw);
    this.bytes += raw.length;
    return ref;
  }
  async flush() {
    if (!this.bytes) return;
    const raw = concat(this.parts),
      sha256 = await digest(raw),
      key = `${this.generation}/${this.kind}-${this.id}.bin`;
    await this.store.bucket.put(key, raw as ArrayBufferView<ArrayBuffer>, {
      sha256,
      customMetadata: { generation: this.generation, sha256 },
    });
    this.objects.push({ id: this.id++, key, size: raw.length, sha256 });
    this.parts = [];
    this.bytes = 0;
  }
}
export async function finishCompletePairs(
  store: BuildStore,
  input: {
    run: CompletePairRun;
    generation: string;
    documents: number;
    objectBase: number;
    commonWords: {
      word: string;
      id: number;
      df: number;
      bodyOccurrences?: number;
      titleOccurrences?: number;
    }[];
    state?: { cursor: PairCursor };
  },
  budget = 8 * 1048576,
) {
  if (input.run.first !== 0 || input.run.end !== input.documents)
    throw Error("Incomplete complete pair corpus");
  const cursor = new Cursor(store, input.run, input.state?.cursor),
    packets = new ServingWriter(
      store,
      input.generation,
      "pairs",
      input.objectBase,
    ),
    positions = new ServingWriter(
      store,
      input.generation,
      "positions",
      input.objectBase,
    ),
    leaves: CompletePairLeaf[] = [],
    hot: {
      a: string;
      b: string;
      df: number;
      bodyDf: number;
      titleDf: number;
      bytes: number;
    }[] = [],
    common = new Set(input.commonWords.map((w) => w.id));
  const presence: {
    rank: number;
    word: string;
    id: number;
    df: number;
    key: string;
    size: number;
    sha256: string;
  }[] = [];
  let entries: { a: string; b: string; data: Uint8Array }[] = [],
    packetBytes = 16,
    packetHash: readonly [number, number] | undefined,
    lastHash: readonly [number, number] | undefined;
  let pairs = 0,
    occurrences = 0,
    memberships = 0,
    bodyMemberships = 0,
    titleMemberships = 0,
    outputBytes = 0;
  const body = new Uint32Array(input.documents),
    title = new Uint32Array(input.documents),
    commonHot: typeof hot = [];
  const flush = async () => {
    if (!entries.length) return;
    const raw = encodePairMembershipPacket(entries),
      ref = await packets.append(raw);
    leaves.push({
      h: packetHash![0],
      h2: packetHash![1],
      object: ref.object,
      offset: ref.offset,
      bytes: raw.length,
      pairs: entries.length,
    });
    entries = [];
    packetBytes = 16;
  };
  let h = await cursor.head();
  while (h) {
    if (
      outputBytes >= budget &&
      (!lastHash || h.h !== lastHash[0] || h.h2 !== lastHash[1])
    )
      break;
    const start = h;
    let bn = 0,
      tn = 0,
      df = 0,
      bo = 0,
      to = 0,
      lastDoc = -1,
      small: Uint8Array[] = [],
      smallBytes = 0,
      smallLast = -1;
    const chunks: PairPositionChunk[] = [];
    let a = -1,
      b = -1;
    const writeContext = async (raw: Uint8Array) => {
      const p = new PairPacket(raw),
        ref = await positions.append(raw);
      chunks.push({
        first: p.docs[0],
        last: p.docs.at(-1)!,
        object: ref.object,
        offset: ref.offset,
        length: ref.length,
      });
    };
    while (h && compare(start, h) === 0) {
      const p = new PairPacket(h.packet);
      if (a < 0) {
        a = p.a;
        b = p.b;
      } else if (p.a !== a || p.b !== b)
        throw Error("Complete pair identity mismatch");
      for (let i = 0; i < p.docs.length; i++) {
        const doc = p.docs[i];
        if (doc < lastDoc || doc >= input.documents)
          throw Error("Unsorted complete pair documents");
        if (doc !== lastDoc) {
          df++;
          lastDoc = doc;
        }
        const x = p.count(i, 0),
          y = p.count(i, 1);
        bo += x;
        to += y;
        if (x && (!bn || body[bn - 1] !== doc)) body[bn++] = doc;
        if (y && (!tn || title[tn - 1] !== doc)) title[tn++] = doc;
      }
      if (start.b === PRESENCE) {
        // Presence rows carry no serving positional payload.
      } else if (
        !chunks.length &&
        p.docs[0] > smallLast &&
        smallBytes + h.packet.length <= 8192
      ) {
        small.push(h.packet.slice());
        smallBytes += h.packet.length;
        smallLast = p.docs.at(-1)!;
      } else {
        for (const raw of small) await writeContext(raw);
        small = [];
        await writeContext(h.packet);
      }
      cursor.take(h);
      h = await cursor.head();
    }
    if (start.b === PRESENCE) {
      const rank = input.commonWords.findIndex(
          (w) => w.id === a && w.word === start.a,
        ),
        word = input.commonWords[rank];
      if (!word || a !== b || word.df !== df)
        throw Error("Common word presence coverage mismatch");
      const raw = encodePairMembership(
        {
          a,
          b,
          df,
          body: body.subarray(0, bn),
          title: title.subarray(0, tn),
          bodyOccurrences: word.bodyOccurrences ?? bn,
          titleOccurrences: word.titleOccurrences ?? tn,
        },
        input.documents,
      );
      const sha256 = await digest(raw),
        key = `${input.generation}/presence-${rank}.bin`;
      await store.bucket.put(key, raw as ArrayBufferView<ArrayBuffer>, {
        sha256,
        customMetadata: { generation: input.generation, sha256 },
      });
      presence.push({
        rank,
        word: word.word,
        id: a,
        df,
        key,
        size: raw.length,
        sha256,
      });
      continue;
    }
    const context = chunks.length
      ? encodePairPositionDirectory(a, b, input.generation, chunks)
      : mergePairPackets(small.map((raw) => new PairPacket(raw)));
    const data = encodePairMembership(
      {
        a,
        b,
        df,
        body: body.subarray(0, bn),
        title: title.subarray(0, tn),
        bodyOccurrences: bo,
        titleOccurrences: to,
        context,
      },
      input.documents,
    );
    const size =
      16 +
      encoder.encode(start.a).length +
      1 +
      encoder.encode(start.b).length +
      data.length;
    if (
      entries.length &&
      packetBytes + size > 131072 &&
      (!lastHash || lastHash[0] !== start.h || lastHash[1] !== start.h2)
    )
      await flush();
    if (!entries.length) packetHash = [start.h, start.h2];
    entries.push({ a: start.a, b: start.b, data });
    packetBytes += size;
    lastHash = [start.h, start.h2];
    outputBytes += size;
    const stat = {
      a: start.a,
      b: start.b,
      df,
      bodyDf: bn,
      titleDf: tn,
      bytes: data.length,
    };
    // Keep a worst-first heap. Sorting 1,000 rows for every tail pair would
    // turn complete coverage into billions of comparisons.
    const worse = (x: typeof stat, y: typeof stat) =>
      x.df - y.df || (x.a < y.a ? 1 : x.a > y.a ? -1 : x.b < y.b ? 1 : -1);
    if (hot.length < 1000) {
      hot.push(stat);
      let i = hot.length - 1;
      while (i) {
        const j = (i - 1) >>> 1;
        if (worse(hot[i], hot[j]) >= 0) break;
        [hot[i], hot[j]] = [hot[j], hot[i]];
        i = j;
      }
    } else if (worse(stat, hot[0]) > 0) {
      hot[0] = stat;
      let i = 0;
      for (;;) {
        let j = i * 2 + 1;
        if (j >= hot.length) break;
        if (j + 1 < hot.length && worse(hot[j + 1], hot[j]) < 0) j++;
        if (worse(hot[j], hot[i]) >= 0) break;
        [hot[i], hot[j]] = [hot[j], hot[i]];
        i = j;
      }
    }
    if (common.has(a) && common.has(b)) commonHot.push(stat);
    pairs++;
    occurrences += bo + to;
    memberships += df;
    bodyMemberships += bn;
    titleMemberships += tn;
  }
  await flush();
  await packets.flush();
  await positions.flush();
  return {
    presence,
    leaves,
    hot: [
      ...new Map(
        [...hot, ...commonHot].map((s) => [s.a + "\0" + s.b, s]),
      ).values(),
    ],
    objects: [...packets.objects, ...positions.objects],
    positionObjects: positions.objects,
    coverage: {
      pairs,
      occurrences,
      memberships,
      bodyMemberships,
      titleMemberships,
      documents: input.documents,
      completeContext: true,
    },
    state: { cursor: cursor.state, done: !h },
  };
}
