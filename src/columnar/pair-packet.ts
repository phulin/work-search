import { concat, pack, unpack, u32, view, lower } from "./format.js";
import {
  encodeSpan,
  decodeSpan,
  packedAt,
  encodeVarints,
  readVarint,
} from "./compact-integers.js";
/** Conservative construction bound, independent of a particular encoding. */
export function pairPacketByteBound(documents: number, occurrences: number) {
  if (
    !Number.isSafeInteger(documents) ||
    documents < 1 ||
    !Number.isSafeInteger(occurrences) ||
    occurrences < documents
  )
    throw Error("Invalid pair size counts");
  return (
    64 +
    28 * documents +
    12 * occurrences +
    48 * Math.min(2 * documents, occurrences - documents)
  );
}
export interface PairOccurrence {
  position: number;
  previous?: number;
  next?: number;
}
export interface PairRow {
  doc: number;
  body: PairOccurrence[];
  title: PairOccurrence[];
}
/** Positional pair packets retain one token on either side of each occurrence.
 * Context ID zero denotes a field boundary; real IDs are encoded as ID + 1. */
export interface PairColumnRow {
  doc: number;
  body: {
    positions: ArrayLike<number>;
    previous: ArrayLike<number>;
    next: ArrayLike<number>;
  };
  title: PairColumnRow["body"];
}
export function encodePairPacket(a: number, b: number, rows: PairRow[]) {
  const context = (id: number | undefined) => {
    if (id === undefined) return 0;
    if (!Number.isInteger(id) || id < 0 || id >= 0xffffffff)
      throw Error("Invalid pair context ID");
    return id + 1;
  };
  const columns = (occurrences: PairOccurrence[]) => ({
    positions: occurrences.map((o) => o.position),
    previous: occurrences.map((o) => context(o.previous)),
    next: occurrences.map((o) => context(o.next)),
  });
  return encodePairColumns(
    a,
    b,
    rows.map((r) => ({
      doc: r.doc,
      body: columns(r.body),
      title: columns(r.title),
    })),
  );
}

interface Members {
  count: number;
  values(): Iterable<number>;
  indexOf(doc: number): number;
}
interface ExternalMembers {
  a: number;
  b: number;
  body: Members;
  title: Members;
  df: number;
}
const PACKET = 0x34505043,
  CONTEXT = 0x31584343;
const NO_POSITIONS = new Uint32Array();
class ArrayMembers implements Members {
  readonly count: number;
  constructor(readonly docs: Uint32Array) {
    this.count = docs.length;
  }
  values() {
    return this.docs;
  }
  indexOf(doc: number) {
    const row = lower(this.docs, doc);
    return this.docs[row] === doc ? row : -1;
  }
}
function encodeField(rows: PairColumnRow["body"][]) {
  const spans: Uint8Array[] = [],
    offsets = [0];
  for (const c of rows) {
    const count = c.positions.length;
    if (!count || c.previous.length !== count || c.next.length !== count)
      throw Error("Pair context count mismatch");
    const raw = concat([
      encodeVarints([count]),
      encodeSpan(c.positions, true),
      encodeSpan(c.previous),
      encodeSpan(c.next),
    ]);
    spans.push(raw);
    offsets.push(offsets.at(-1)! + raw.length);
  }
  if (rows.length <= 1) return concat(spans);
  const directory = pack(offsets);
  return concat([u32([directory.length]), directory, ...spans]);
}
/** Context is ordered by each field's existing membership list. No identities,
 * duplicate document lists, or directories for absent fields are serialized. */
export function encodePairColumns(a: number, b: number, rows: PairColumnRow[]) {
  if (
    ![a, b].every((n) => Number.isInteger(n) && n >= 0 && n < 0xffffffff) ||
    !rows.length ||
    rows.some(
      (r, i) =>
        !Number.isInteger(r.doc) ||
        r.doc < 0 ||
        r.doc > 0xffffffff ||
        (i > 0 && r.doc <= rows[i - 1].doc) ||
        (!r.body.positions.length && !r.title.positions.length),
    )
  )
    throw Error("Invalid positional pair rows");
  const body = rows.filter((r) => r.body.positions.length),
    title = rows.filter((r) => r.title.positions.length),
    bd = body.length
      ? pack(
          body.map((r) => r.doc),
          true,
        )
      : new Uint8Array(),
    td = title.length
      ? pack(
          title.map((r) => r.doc),
          true,
        )
      : new Uint8Array(),
    bf = encodeField(body.map((r) => r.body)),
    tf = encodeField(title.map((r) => r.title)),
    context = concat([u32([CONTEXT, bf.length, tf.length]), bf, tf]);
  return concat([
    u32([PACKET, a, b, bd.length, td.length, context.length]),
    bd,
    td,
    context,
  ]);
}
class ContextField {
  private directory?: Uint8Array;
  private spans: Uint8Array;
  constructor(
    readonly data: Uint8Array,
    readonly members: Members,
  ) {
    if (!members.count) {
      if (data.length) throw Error("Unexpected empty-field context");
      this.spans = data;
      return;
    }
    if (members.count === 1) {
      this.spans = data;
      return;
    }
    if (data.length < 16) throw Error("Truncated pair field directory");
    const length = view(data).getUint32(0, true);
    if (length < 12 || 4 + length > data.length)
      throw Error("Invalid pair field directory");
    this.directory = data.subarray(4, 4 + length);
    this.spans = data.subarray(4 + length);
    if (
      view(this.directory).getUint32(0, true) !== members.count + 1 ||
      packedAt(this.directory, 0) ||
      packedAt(this.directory, members.count) !== this.spans.length
    )
      throw Error("Invalid pair field offsets");
  }
  raw(doc: number) {
    const row = this.members.indexOf(doc);
    if (row < 0) return undefined;
    if (!this.directory) return this.spans;
    const from = packedAt(this.directory, row),
      end = packedAt(this.directory, row + 1);
    if (end <= from || end > this.spans.length)
      throw Error("Invalid pair occurrence span");
    return this.spans.subarray(from, end);
  }
  columns() {
    const docs = Uint32Array.from(this.members.values()),
      offsets = new Uint32Array(docs.length + 1);
    for (let i = 0; i <= docs.length; i++)
      offsets[i] = this.directory
        ? packedAt(this.directory, i)
        : i
          ? this.spans.length
          : 0;
    return { docs, offsets, spans: this.spans };
  }
}
export class PairPacket {
  readonly a: number;
  readonly b: number;
  readonly docs: Uint32Array;
  readonly contextBytes: Uint8Array;
  private fields: ContextField[];
  constructor(
    readonly bytes: Uint8Array,
    readonly decoded?: (
      row: number,
      field: number,
      occurrences: number,
      bytes: number,
    ) => void,
    external?: ExternalMembers,
  ) {
    let body: Members, title: Members;
    if (external) {
      this.a = external.a;
      this.b = external.b;
      body = external.body;
      title = external.title;
      this.contextBytes = bytes;
    } else {
      const v = view(bytes);
      if (bytes.length < 24 || v.getUint32(0, true) !== PACKET)
        throw Error("Invalid pair packet");
      this.a = v.getUint32(4, true);
      this.b = v.getUint32(8, true);
      const bn = v.getUint32(12, true),
        tn = v.getUint32(16, true),
        cn = v.getUint32(20, true);
      if (24 + bn + tn + cn !== bytes.length)
        throw Error("Invalid pair directory");
      const bd = bn ? unpack(bytes.subarray(24, 24 + bn)) : new Uint32Array(),
        td = tn
          ? unpack(bytes.subarray(24 + bn, 24 + bn + tn))
          : new Uint32Array();
      for (const docs of [bd, td])
        if (docs.some((d, i) => i > 0 && d <= docs[i - 1]))
          throw Error("Invalid pair document order");
      body = new ArrayMembers(bd);
      title = new ArrayMembers(td);
      this.contextBytes = bytes.subarray(24 + bn + tn);
    }
    const ctx = this.contextBytes,
      v = view(ctx);
    if (ctx.length < 12 || v.getUint32(0, true) !== CONTEXT)
      throw Error("Invalid pair context");
    const bn = v.getUint32(4, true),
      tn = v.getUint32(8, true);
    if (12 + bn + tn !== ctx.length)
      throw Error("Invalid pair context sections");
    this.fields = [
      new ContextField(ctx.subarray(12, 12 + bn), body),
      new ContextField(ctx.subarray(12 + bn), title),
    ];
    if (body instanceof ArrayMembers && title instanceof ArrayMembers) {
      const bd = body.docs,
        td = title.docs;
      if (!bd.length) this.docs = td;
      else if (!td.length) this.docs = bd;
      else {
        const merged = new Uint32Array(bd.length + td.length);
        let b = 0,
          t = 0,
          n = 0;
        while (b < bd.length || t < td.length) {
          const doc = Math.min(
            b < bd.length ? bd[b] : Infinity,
            t < td.length ? td[t] : Infinity,
          );
          merged[n++] = doc;
          if (bd[b] === doc) b++;
          if (td[t] === doc) t++;
        }
        this.docs = merged.subarray(0, n);
      }
      if (!this.docs.length) throw Error("Pair context identity mismatch");
      return;
    }
    const merged = new Uint32Array(body.count + title.count),
      bi = body.values()[Symbol.iterator](),
      ti = title.values()[Symbol.iterator]();
    let x = bi.next(),
      y = ti.next(),
      n = 0;
    while (!x.done || !y.done) {
      const d = Math.min(
        x.done ? Infinity : x.value,
        y.done ? Infinity : y.value,
      );
      merged[n++] = d;
      if (!x.done && x.value === d) x = bi.next();
      if (!y.done && y.value === d) y = ti.next();
    }
    this.docs = merged.subarray(0, n);
    if (!n || (external && n !== external.df))
      throw Error("Pair context identity mismatch");
  }
  private raw(row: number, field: number) {
    if (
      !Number.isInteger(row) ||
      row < 0 ||
      row >= this.docs.length ||
      (field !== 0 && field !== 1)
    )
      throw Error("Invalid pair row");
    return this.fields[field].raw(this.docs[row]);
  }
  /** Construction can concatenate exact encoded context spans without
   * materializing three occurrence arrays and an object for every document. */
  encodedField(field: number) {
    if (field !== 0 && field !== 1) throw Error("Invalid pair field");
    return this.fields[field].columns();
  }
  count(row: number, field: number) {
    const raw = this.raw(row, field);
    return raw ? readVarint(raw, 0).value : 0;
  }
  occurrences(row: number, field: number) {
    const raw = this.raw(row, field);
    if (!raw)
      return {
        positions: new Uint32Array(),
        previous: new Uint32Array(),
        next: new Uint32Array(),
      };
    const { value: count, next: at } = readVarint(raw, 0);
    if (!count || count > raw.length * 32)
      throw Error("Invalid pair occurrence count");
    const positions = decodeSpan(raw, at, count, true),
      previous = decodeSpan(raw, positions.next, count),
      next = decodeSpan(raw, previous.next, count);
    if (next.next !== raw.length) throw Error("Invalid pair context columns");
    this.decoded?.(row, field, count, raw.length);
    return {
      positions: positions.values,
      previous: previous.values,
      next: next.values,
    };
  }
  /** Every phrase occurrence must contain this indexed adjacent pair. Short
   * context proves 2–4-token phrases; longer phrases retain unknown candidates. */
  phrase(row: number, field: number, words: number[], anchor: number) {
    if (anchor < 0 || words[anchor] !== this.a || words[anchor + 1] !== this.b)
      throw Error("Pair does not anchor phrase");
    // Singleton rows dominate sparse pair streams. Check their encoded context
    // directly instead of allocating three decoded columns for every document.
    const raw = this.raw(row, field);
    if (!raw) return { certain: true, starts: NO_POSITIONS };
    const count = readVarint(raw, 0);
    if (count.value === 1) {
      const position = readVarint(raw, count.next),
        previous = readVarint(raw, position.next),
        next = readVarint(raw, previous.next);
      if (next.next !== raw.length) throw Error("Invalid pair context columns");
      this.decoded?.(row, field, 1, raw.length);
      const matches =
        position.value >= anchor &&
        (anchor === 0 || previous.value === words[anchor - 1] + 1) &&
        (anchor + 2 >= words.length || next.value === words[anchor + 2] + 1);
      return {
        certain: !matches || (anchor <= 1 && words.length - anchor - 2 <= 1),
        starts: matches
          ? Uint32Array.of(position.value - anchor)
          : NO_POSITIONS,
      };
    }
    const o = this.occurrences(row, field),
      starts = new Uint32Array(o.positions.length);
    let n = 0;
    for (let i = 0; i < o.positions.length; i++) {
      const p = o.positions[i];
      if (
        p < anchor ||
        (anchor > 0 && o.previous[i] !== words[anchor - 1] + 1) ||
        (anchor + 2 < words.length && o.next[i] !== words[anchor + 2] + 1)
      )
        continue;
      starts[n++] = p - anchor;
    }
    return {
      certain: n === 0 || (anchor <= 1 && words.length - anchor - 2 <= 1),
      starts: starts.subarray(0, n),
    };
  }
}
/** Construction fan-in is bounded by the selected packet byte budget. */
export function mergePairPackets(packets: PairPacket[]) {
  if (!packets.length) throw Error("Pair merge requires packets");
  const sorted = [...packets].sort((a, b) => a.docs[0] - b.docs[0]),
    a = sorted[0].a,
    b = sorted[0].b;
  let previous = -1;
  for (const p of sorted) {
    if (p.a !== a || p.b !== b || p.docs[0] <= previous)
      throw Error("Pair merge document overlap or ID mismatch");
    previous = p.docs.at(-1)!;
  }
  const fields = [0, 1].map((field) => {
    const columns = sorted.map((p) => p.encodedField(field)),
      count = columns.reduce((n, c) => n + c.docs.length, 0),
      docs = new Uint32Array(count),
      offsets = new Uint32Array(count + 1);
    let row = 0,
      bytes = 0;
    for (const c of columns) {
      docs.set(c.docs, row);
      for (let i = 0; i < c.docs.length; i++)
        offsets[row + i] = bytes + c.offsets[i];
      row += c.docs.length;
      bytes += c.spans.length;
    }
    offsets[count] = bytes;
    const spans = concat(columns.map((c) => c.spans)),
      directory = count > 1 ? pack(offsets) : undefined;
    return {
      members: count ? pack(docs, true) : new Uint8Array(),
      context: directory
        ? concat([u32([directory.length]), directory, spans])
        : spans,
    };
  });
  const context = concat([
    u32([CONTEXT, fields[0].context.length, fields[1].context.length]),
    fields[0].context,
    fields[1].context,
  ]);
  return concat([
    u32([
      PACKET,
      a,
      b,
      fields[0].members.length,
      fields[1].members.length,
      context.length,
    ]),
    fields[0].members,
    fields[1].members,
    context,
  ]);
}
/** Mandatory pair intersections retain a document only when all pair anchors
 * coexist in one allowed field. This is a filter, never phrase proof by itself. */
export function intersectPairDocuments(
  packets: PairPacket[],
  field: "all" | "body" | "title" = "all",
) {
  if (!packets.length) throw Error("Pair intersection needs an indexed anchor");
  const sorted = [...packets].sort((a, b) => a.docs.length - b.docs.length),
    out = new Uint32Array(sorted[0].docs.length),
    cursors = new Uint32Array(sorted.length);
  let n = 0;
  for (let row = 0; row < sorted[0].docs.length; row++) {
    const doc = sorted[0].docs[row];
    let body = field !== "title",
      title = field !== "body";
    for (let i = 0; i < sorted.length; i++) {
      const packet = sorted[i];
      let r = i === 0 ? row : cursors[i];
      while (r < packet.docs.length && packet.docs[r] < doc) r++;
      cursors[i] = r;
      if (packet.docs[r] !== doc) {
        body = title = false;
        break;
      }
      body &&= packet.count(r, 0) > 0;
      title &&= packet.count(r, 1) > 0;
      if (!body && !title) break;
    }
    if (body || title) out[n++] = doc;
  }
  return out.subarray(0, n);
}
