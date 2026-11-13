import { concat, pack, unpack, u32, view, lower } from "./format.js";
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
export function encodePairPacket(a: number, b: number, rows: PairRow[]) {
  if (
    ![a, b].every((n) => Number.isInteger(n) && n >= 0 && n < 0xffffffff) ||
    !rows.length ||
    rows.some(
      (r, i) =>
        r.doc < 0 ||
        !Number.isInteger(r.doc) ||
        (i > 0 && r.doc <= rows[i - 1].doc) ||
        (!r.body.length && !r.title.length),
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
  for (const r of rows)
    for (const occurrences of [r.body, r.title]) {
      if (
        occurrences.some(
          (o, i) =>
            !Number.isInteger(o.position) ||
            o.position < 0 ||
            (i > 0 && o.position <= occurrences[i - 1].position) ||
            [o.previous, o.next].some(
              (t) =>
                t !== undefined &&
                (!Number.isInteger(t) || t < 0 || t >= 0xffffffff),
            ),
        )
      )
        throw Error("Invalid pair occurrence");
      const columns = [
          pack(
            occurrences.map((o) => o.position),
            true,
          ),
          pack(
            occurrences.map((o) =>
              o.previous === undefined ? 0 : o.previous + 1,
            ),
          ),
          pack(occurrences.map((o) => (o.next === undefined ? 0 : o.next + 1))),
        ],
        raw = concat([u32(columns.map((c) => c.length)), ...columns]);
      index.push(at, raw.length, occurrences.length);
      spans.push(raw);
      at += raw.length;
    }
  return concat([
    u32([0x32505043, a, b, rows.length, docs.length, index.length * 4, at, 1]),
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
  constructor(readonly bytes: Uint8Array) {
    const v = view(bytes);
    if (
      bytes.length < 32 ||
      v.getUint32(0, true) !== 0x32505043 ||
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
    if (row < 0 || row >= this.docs.length || (field !== 0 && field !== 1))
      throw Error("Invalid pair row");
    return this.index.getUint32(row * 24 + field * 12 + 8, true);
  }
  occurrences(row: number, field: number) {
    const count = this.count(row, field),
      p = row * 24 + field * 12,
      at = this.index.getUint32(p, true),
      n = this.index.getUint32(p + 4, true);
    if (n < 12 || at + n > this.spans.length)
      throw Error("Invalid pair occurrence span");
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
