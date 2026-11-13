import { concat, pack, unpack, u32, view, lower } from "./format.js";
/** A multi-occurrence field adds 48 bytes of column headers. Every such field
 * requires an occurrence beyond the document's first, with at most two fields
 * per document. Doc IDs, index rows and integers use worst-case 32-bit widths. */
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
/** Numeric builder entry avoids allocating one object per occurrence. Empty
 * fields need no bytes; singleton occurrences store just three integers. */
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
  const docs = pack(
      rows.map((r) => r.doc),
      true,
    ),
    index: number[] = [],
    spans: Uint8Array[] = [];
  let at = 0;
  for (const row of rows)
    for (const c of [row.body, row.title]) {
      const count = c.positions.length;
      if (c.previous.length !== count || c.next.length !== count)
        throw Error("Pair context count mismatch");
      for (let i = 0; i < count; i++)
        if (
          ![c.positions[i], c.previous[i], c.next[i]].every(
            (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff,
          ) ||
          (i > 0 && c.positions[i] <= c.positions[i - 1])
        )
          throw Error("Invalid pair occurrence");
      let raw: Uint8Array;
      if (!count) raw = new Uint8Array();
      else if (count === 1)
        raw = u32([c.positions[0], c.previous[0], c.next[0]]);
      else {
        const columns = [
          pack(c.positions, true),
          pack(c.previous),
          pack(c.next),
        ];
        raw = concat([u32(columns.map((c) => c.length)), ...columns]);
      }
      index.push(at, raw.length, count);
      spans.push(raw);
      at += raw.length;
    }
  return concat([
    u32([0x33505043, a, b, rows.length, docs.length, index.length * 4, at, 1]),
    docs,
    u32(index),
    ...spans,
  ]);
}
export class PairPacket {
  readonly a: number;
  readonly b: number;
  readonly docs: Uint32Array;
  readonly index: DataView;
  readonly spans: Uint8Array;
  constructor(
    readonly bytes: Uint8Array,
    readonly decoded?: (
      row: number,
      field: number,
      occurrences: number,
      bytes: number,
    ) => void,
  ) {
    const v = view(bytes);
    if (
      bytes.length < 32 ||
      v.getUint32(0, true) !== 0x33505043 ||
      v.getUint32(28, true) !== 1
    )
      throw Error("Invalid pair packet");
    this.a = v.getUint32(4, true);
    this.b = v.getUint32(8, true);
    const n = v.getUint32(12, true),
      dn = v.getUint32(16, true),
      ix = v.getUint32(20, true),
      sn = v.getUint32(24, true);
    if (!n || ix !== n * 24 || 32 + dn + ix + sn !== bytes.length)
      throw Error("Invalid pair directory");
    this.docs = unpack(bytes.subarray(32, 32 + dn));
    if (
      this.docs.length !== n ||
      this.docs.some((d, i) => i > 0 && d <= this.docs[i - 1])
    )
      throw Error("Invalid pair document order");
    this.index = view(bytes.subarray(32 + dn, 32 + dn + ix));
    this.spans = bytes.subarray(32 + dn + ix);
  }
  count(row: number, field: number) {
    if (
      !Number.isInteger(row) ||
      row < 0 ||
      row >= this.docs.length ||
      (field !== 0 && field !== 1)
    )
      throw Error("Invalid pair row");
    return this.index.getUint32(row * 24 + field * 12 + 8, true);
  }
  occurrences(row: number, field: number) {
    const count = this.count(row, field),
      p = row * 24 + field * 12,
      at = this.index.getUint32(p, true),
      n = this.index.getUint32(p + 4, true);
    if (at + n > this.spans.length || (count === 0 ? n !== 0 : n < 12))
      throw Error("Invalid pair occurrence span");
    this.decoded?.(row, field, count, n);
    if (!count)
      return {
        positions: new Uint32Array(),
        previous: new Uint32Array(),
        next: new Uint32Array(),
      };
    if (count === 1) {
      if (n !== 12) throw Error("Invalid singleton pair context");
      const v = view(this.spans.subarray(at, at + n));
      return {
        positions: Uint32Array.of(v.getUint32(0, true)),
        previous: Uint32Array.of(v.getUint32(4, true)),
        next: Uint32Array.of(v.getUint32(8, true)),
      };
    }
    const raw = this.spans.subarray(at, at + n),
      v = view(raw),
      arrays: Uint32Array[] = [];
    let offset = 12;
    for (let i = 0; i < 3; i++) {
      const length = v.getUint32(i * 4, true);
      if (offset + length > raw.length) throw Error("Truncated pair context");
      arrays.push(unpack(raw.subarray(offset, offset + length)));
      offset += length;
    }
    if (
      offset !== raw.length ||
      arrays.some((a) => a.length !== count) ||
      arrays[0].some((p, i) => i > 0 && p <= arrays[0][i - 1])
    )
      throw Error("Invalid pair context columns");
    return { positions: arrays[0], previous: arrays[1], next: arrays[2] };
  }
  /** Every phrase occurrence must contain this indexed adjacent pair. Short
   * context proves 2–4-token phrases; longer phrases retain unknown candidates. */
  phrase(row: number, field: number, words: number[], anchor: number) {
    if (anchor < 0 || words[anchor] !== this.a || words[anchor + 1] !== this.b)
      throw Error("Pair does not anchor phrase");
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
/** Merge disjoint document ranges without decoding occurrence/context integers.
 * Native fan-in keeps the complete packet below its selected size budget. */
export function mergePairPackets(packets: PairPacket[]) {
  if (!packets.length) throw Error("Pair merge requires packets");
  const sorted = [...packets].sort((a, b) => a.docs[0] - b.docs[0]),
    a = sorted[0].a,
    b = sorted[0].b,
    count = sorted.reduce((n, p) => n + p.docs.length, 0),
    docs = new Uint32Array(count),
    index = new Uint8Array(count * 24),
    v = view(index);
  let row = 0,
    offset = 0,
    previous = -1;
  for (const p of sorted) {
    if (p.a !== a || p.b !== b || p.docs[0] <= previous)
      throw Error("Pair merge document overlap or ID mismatch");
    docs.set(p.docs, row);
    for (let r = 0; r < p.docs.length; r++)
      for (let field = 0; field < 2; field++) {
        const from = r * 24 + field * 12,
          to = (row + r) * 24 + field * 12,
          at = p.index.getUint32(from, true),
          n = p.index.getUint32(from + 4, true),
          count = p.index.getUint32(from + 8, true);
        if (
          at + n > p.spans.length ||
          (count === 0 ? n !== 0 : count === 1 ? n !== 12 : n < 12)
        )
          throw Error("Invalid merged pair span");
        v.setUint32(to, at + offset, true);
        v.setUint32(to + 4, n, true);
        v.setUint32(to + 8, count, true);
      }
    row += p.docs.length;
    offset += p.spans.length;
    previous = p.docs.at(-1)!;
  }
  const encoded = pack(docs, true);
  return concat([
    u32([0x33505043, a, b, count, encoded.length, index.length, offset, 1]),
    encoded,
    index,
    ...sorted.map((p) => p.spans),
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
