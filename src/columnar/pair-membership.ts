import { concat, lower, pack, unpack, u32, view } from "./format.js";
import { PairPacket } from "./pair-packet.js";
import {
  isCompletePairRanges,
  decodeCompletePairRanges,
  type ExactPairRanges,
} from "./pair-ranges.js";
import { encodeVarints, readVarint } from "./compact-integers.js";
import {
  PairPositionDirectory,
  isPairPositionDirectory,
  type PairEvidence,
} from "./pair-positions.js";

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export const PAIR_PACKET_MAGIC = 0x324d5043;
/** Hashes route only. Exact normalized UTF-8 keys always establish identity. */
export function pairStringHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return (h ^ (h >>> 16)) >>> 0;
}
export function pairHash(a: number, b: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h ^= h >>> 16;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
export const pairStringKey = (a: string, b: string) => a + "\0" + b;
export function encodeMembership(docs: Uint32Array, count: number) {
  if (docs.some((d, i) => d >= count || (i > 0 && d <= docs[i - 1])))
    throw Error("Invalid pair memberships");
  if (!docs.length) return { mode: 0, data: new Uint8Array() };
  if (docs.length === 1) return { mode: 1, data: u32(docs) };
  const blocks: Uint8Array[] = [],
    index = new Uint8Array(4 + Math.ceil(docs.length / 128) * 12),
    v = view(index);
  v.setUint32(0, Math.ceil(docs.length / 128), true);
  let offset = index.length;
  for (let first = 0; first < docs.length; first += 128) {
    const block = pack(docs.subarray(first, first + 128), true),
      i = first / 128;
    v.setUint32(4 + i * 12, docs[Math.min(first + 127, docs.length - 1)], true);
    v.setUint32(8 + i * 12, offset, true);
    v.setUint32(12 + i * 12, block.length, true);
    blocks.push(block);
    offset += block.length;
  }
  return { mode: 2, data: concat([index, ...blocks]) };
}
/** Sorted document lists with independent 128-document restarts. Only visited
 * blocks decode, into bounded numeric arrays. All densities use lists. */
export class Membership {
  private docs?: Uint32Array;
  private index?: DataView;
  private blocks = 0;
  private cached = -1;
  private column?: Uint32Array;
  constructor(
    readonly data: Uint8Array,
    readonly mode: number,
    readonly count: number,
    readonly corpusCount: number,
    readonly observe?: (block: number, integers: number, bytes: number) => void,
  ) {
    if (!Number.isInteger(count) || count < 0 || count > corpusCount)
      throw Error("Invalid membership count");
    if (mode === 0) {
      if (count || data.length) throw Error("Invalid empty membership");
      this.docs = new Uint32Array();
    } else if (mode === 1) {
      if (count !== 1 || data.length !== 4)
        throw Error("Invalid singleton membership");
      this.docs = Uint32Array.of(view(data).getUint32(0, true));
      this.observe?.(0, 1, 4);
    } else if (mode === 2) {
      this.index = view(data);
      this.blocks = this.index.getUint32(0, true);
      if (
        this.blocks !== Math.ceil(count / 128) ||
        4 + this.blocks * 12 > data.length
      )
        throw Error("Invalid membership restart table");
      let offset = 4 + this.blocks * 12,
        last = -1;
      for (let i = 0; i < this.blocks; i++) {
        const end = this.index.getUint32(4 + i * 12, true),
          at = this.index.getUint32(8 + i * 12, true),
          n = this.index.getUint32(12 + i * 12, true);
        if (
          end <= last ||
          end >= corpusCount ||
          at !== offset ||
          n < 12 ||
          at + n > data.length
        )
          throw Error("Invalid membership block address");
        offset = at + n;
        last = end;
      }
      if (offset !== data.length) throw Error("Trailing membership data");
    } else throw Error("Invalid membership mode");
    if (
      this.docs?.some(
        (d, i) => d >= corpusCount || (i > 0 && d <= this.docs![i - 1]),
      )
    )
      throw Error("Invalid membership order");
  }
  private block(i: number) {
    if (this.cached === i) return this.column!;
    const at = this.index!.getUint32(8 + i * 12, true),
      n = this.index!.getUint32(12 + i * 12, true),
      docs = unpack(this.data.subarray(at, at + n)),
      previous = i ? this.index!.getUint32(4 + (i - 1) * 12, true) : -1;
    if (
      docs.length !== Math.min(128, this.count - i * 128) ||
      docs[docs.length - 1] !== this.index!.getUint32(4 + i * 12, true) ||
      docs.some((d, j) => d <= (j ? docs[j - 1] : previous))
    )
      throw Error("Invalid membership block order");
    this.cached = i;
    this.observe?.(i, docs.length, docs.byteLength);
    return (this.column = docs);
  }
  indexOf(doc: number) {
    if (doc < 0 || doc >= this.corpusCount) return -1;
    if (this.docs) {
      const row = lower(this.docs, doc);
      return this.docs[row] === doc ? row : -1;
    }
    let lo = 0,
      hi = this.blocks;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.index!.getUint32(4 + m * 12, true) < doc) lo = m + 1;
      else hi = m;
    }
    if (lo === this.blocks) return -1;
    const docs = this.block(lo),
      row = lower(docs, doc);
    return docs[row] === doc ? lo * 128 + row : -1;
  }
  has(doc: number) {
    return this.indexOf(doc) >= 0;
  }
  *values(): Generator<number> {
    if (this.docs) {
      yield* this.docs;
      return;
    }
    for (let i = 0; i < this.blocks; i++) yield* this.block(i);
  }
  cursor() {
    let row = 0,
      block = 0,
      position = 0,
      column: Uint32Array | undefined;
    return {
      next: (): number => {
        if (this.docs)
          return row < this.docs.length ? this.docs[row++] : Infinity;
        if (!column || position === column.length) {
          if (block === this.blocks) return Infinity;
          column = this.block(block++);
          position = 0;
        }
        return column[position++];
      },
    };
  }
}
export interface PairMembershipRecord {
  a: number;
  b: number;
  df: number;
  body: Uint32Array;
  title: Uint32Array;
  bodyOccurrences: number;
  titleOccurrences: number;
  context?: Uint8Array;
}
export type ObserveMembership = (
  field: number,
  block: number,
  integers: number,
  bytes: number,
) => void;
export function encodePairMembership(
  record: PairMembershipRecord,
  corpusCount: number,
) {
  const b = encodeMembership(record.body, corpusCount),
    t = encodeMembership(record.title, corpusCount),
    context = record.context
      ? isPairPositionDirectory(record.context) ||
        isCompletePairRanges(record.context)
        ? record.context
        : new PairPacket(record.context).contextBytes
      : new Uint8Array();
  return concat([
    Uint8Array.of(4),
    encodeVarints([
      record.a,
      record.b,
      record.df,
      record.body.length,
      record.title.length,
      record.bodyOccurrences,
      record.titleOccurrences,
      b.data.length,
      t.data.length,
      context.length,
      b.mode | (t.mode << 2),
    ]),
    b.data,
    t.data,
    context,
  ]);
}
export class PairMembership {
  readonly a: number;
  readonly b: number;
  readonly df: number;
  readonly bodyOccurrences: number;
  readonly titleOccurrences: number;
  readonly body: Membership;
  readonly title: Membership;
  readonly context?: PairPacket;
  readonly positionDirectory?: PairPositionDirectory;
  readonly completePositions?: ExactPairRanges;
  supplementalContext?: PairEvidence;
  constructor(
    readonly bytes: Uint8Array,
    count: number,
    observe?: ConstructorParameters<typeof PairPacket>[1],
    observeMembership?: ObserveMembership,
  ) {
    if (bytes.length < 12 || bytes[0] !== 4)
      throw Error("Invalid pair record version");
    const header: number[] = [];
    let at = 1;
    for (let i = 0; i < 11; i++) {
      const item = readVarint(bytes, at);
      header.push(item.value);
      at = item.next;
    }
    const bn = header[7],
      tn = header[8],
      cn = header[9],
      flags = header[10];
    if (at + bn + tn + cn !== bytes.length || flags > 15)
      throw Error("Invalid pair record sections");
    this.a = header[0];
    this.b = header[1];
    this.df = header[2];
    this.bodyOccurrences = header[5];
    this.titleOccurrences = header[6];
    this.body = new Membership(
      bytes.subarray(at, at + bn),
      flags & 3,
      header[3],
      count,
      observeMembership
        ? (block, n, bytes) => observeMembership(0, block, n, bytes)
        : undefined,
    );
    this.title = new Membership(
      bytes.subarray(at + bn, at + bn + tn),
      flags >>> 2,
      header[4],
      count,
      observeMembership
        ? (block, n, bytes) => observeMembership(1, block, n, bytes)
        : undefined,
    );
    if (
      this.df < Math.max(this.body.count, this.title.count) ||
      this.df > Math.min(count, this.body.count + this.title.count)
    )
      throw Error("Invalid pair DF");
    if (cn && isCompletePairRanges(bytes.subarray(at + bn + tn))) {
      this.completePositions = decodeCompletePairRanges(
        bytes.subarray(at + bn + tn),
      );
      if (
        this.completePositions.a !== this.a ||
        this.completePositions.b !== this.b
      )
        throw Error("Complete pair term identity mismatch");
    } else if (cn && isPairPositionDirectory(bytes.subarray(at + bn + tn))) {
      this.positionDirectory = new PairPositionDirectory(
        bytes.subarray(at + bn + tn),
      );
      if (
        this.positionDirectory.a !== this.a ||
        this.positionDirectory.b !== this.b
      )
        throw Error("Pair position directory identity mismatch");
    } else if (cn) {
      this.context = new PairPacket(bytes.subarray(at + bn + tn), observe, {
        a: this.a,
        b: this.b,
        body: this.body,
        title: this.title,
        df: this.df,
      });
      if (
        this.context.a !== this.a ||
        this.context.b !== this.b ||
        this.context.docs.length !== this.df
      )
        throw Error("Pair context identity mismatch");
    }
  }
  has(doc: number, field: "all" | "body" | "title") {
    return field === "all"
      ? this.body.has(doc) || this.title.has(doc)
      : this[field].has(doc);
  }
  *documents(field: "all" | "body" | "title"): Generator<number> {
    if (field !== "all") {
      yield* this[field].values();
      return;
    }
    const a = this.body.values(),
      b = this.title.values();
    let x = a.next(),
      y = b.next();
    while (!x.done || !y.done) {
      const d = Math.min(
        x.done ? Infinity : x.value,
        y.done ? Infinity : y.value,
      );
      yield d;
      if (!x.done && x.value === d) x = a.next();
      if (!y.done && y.value === d) y = b.next();
    }
  }
  cursor(field: "all" | "body" | "title") {
    if (field !== "all") return this[field].cursor();
    const a = this.body.cursor(),
      b = this.title.cursor();
    let x = a.next(),
      y = b.next();
    return {
      next: () => {
        const doc = Math.min(x, y);
        if (x === doc) x = a.next();
        if (y === doc) y = b.next();
        return doc;
      },
    };
  }
}
export function encodePairMembershipPacket(
  entries: { a: string; b: string; data: Uint8Array }[],
) {
  entries = [...entries].sort((a, b) =>
    pairStringKey(a.a, a.b) < pairStringKey(b.a, b.b) ? -1 : 1,
  );
  const keys = entries.map((e) => encoder.encode(pairStringKey(e.a, e.b))),
    header = new Uint8Array(16 + entries.length * 16),
    v = view(header);
  let at = header.length;
  v.setUint32(0, PAIR_PACKET_MAGIC, true);
  v.setUint32(4, entries.length, true);
  keys.forEach((key, i) => {
    v.setUint32(16 + i * 16, at, true);
    v.setUint32(20 + i * 16, key.length, true);
    at += key.length;
  });
  v.setUint32(8, at, true);
  entries.forEach((entry, i) => {
    v.setUint32(24 + i * 16, at, true);
    v.setUint32(28 + i * 16, entry.data.length, true);
    at += entry.data.length;
  });
  v.setUint32(12, at, true);
  return concat([header, ...keys, ...entries.map((e) => e.data)]);
}
/** Only the selected pair's membership/context is decoded, never its neighbors. */
export class PairMembershipPacket {
  private v: DataView;
  readonly count: number;
  constructor(readonly bytes: Uint8Array) {
    this.v = view(bytes);
    if (bytes.length < 16 || this.v.getUint32(0, true) !== PAIR_PACKET_MAGIC)
      throw Error("Invalid membership packet");
    this.count = this.v.getUint32(4, true);
    if (
      16 + this.count * 16 > bytes.length ||
      this.v.getUint32(12, true) !== bytes.length
    )
      throw Error("Invalid membership packet table");
  }
  private key(i: number) {
    const at = this.v.getUint32(16 + i * 16, true),
      n = this.v.getUint32(20 + i * 16, true);
    if (at < 16 + this.count * 16 || at + n > this.v.getUint32(8, true))
      throw Error("Invalid pair key");
    return decoder.decode(this.bytes.subarray(at, at + n));
  }
  record(a: string, b: string) {
    const key = pairStringKey(a, b);
    let lo = 0,
      hi = this.count;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.key(m) < key) lo = m + 1;
      else hi = m;
    }
    if (lo === this.count || this.key(lo) !== key) return;
    const at = this.v.getUint32(24 + lo * 16, true),
      n = this.v.getUint32(28 + lo * 16, true);
    if (at < this.v.getUint32(8, true) || at + n > this.bytes.length)
      throw Error("Invalid pair record address");
    return this.bytes.subarray(at, at + n);
  }
  lookup(
    a: string,
    b: string,
    corpusCount: number,
    observe?: ConstructorParameters<typeof PairPacket>[1],
    observeMembership?: ObserveMembership,
  ) {
    const raw = this.record(a, b);
    return raw
      ? new PairMembership(raw, corpusCount, observe, observeMembership)
      : undefined;
  }
}
