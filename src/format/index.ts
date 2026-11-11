import { decoder, encoder } from "./codec.js";
import { DocumentTable } from "./documents.js";
export const MAGIC = 0x31535742,
  VERSION = 4,
  HEADER = 128,
  TERM = 40,
  LOCAL = 0xffffffff;
export interface Entry {
  term: string;
  df: number;
  object: number;
  offset: number;
  length: number;
  crc: number;
  positionObject: number;
  positionOffset: number;
  positionLength: number;
  positionCrc: number;
}
export class BinaryIndex {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly count: number;
  readonly termCount: number;
  readonly generation: string;
  readonly avgBody: number;
  readonly avgTitle: number;
  readonly dict: number;
  readonly strings: number;
  readonly docs: number;
  readonly documents: DocumentTable;
  readonly local: number;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    if (
      bytes.length < HEADER ||
      v.getUint32(0, true) !== MAGIC ||
      v.getUint32(4, true) !== VERSION
    )
      throw new Error("Index magic/version mismatch");
    if (v.getUint32(8, true) !== bytes.length)
      throw new Error("Index length mismatch");
    this.count = v.getUint32(12, true);
    this.termCount = v.getUint32(16, true);
    this.avgBody = v.getFloat64(24, true);
    this.avgTitle = v.getFloat64(32, true);
    this.dict = v.getUint32(40, true);
    this.strings = v.getUint32(44, true);
    this.docs = v.getUint32(48, true);

    this.local = v.getUint32(56, true);
    this.generation = decoder.decode(bytes.subarray(64, 128));
    if (
      this.dict !== HEADER ||
      this.strings !== HEADER + this.termCount * TERM ||
      this.docs < this.strings ||
      v.getUint32(52, true) !== 0 ||
      this.local < this.docs ||
      this.local > bytes.length ||
      !Number.isFinite(this.avgBody) ||
      !Number.isFinite(this.avgTitle)
    )
      throw new Error("Invalid index sections");
    this.documents = new DocumentTable(
      bytes.subarray(this.docs, this.local),
      this.count,
    );
  }
  entry(i: number): Entry {
    const v = this.view,
      p = this.dict + i * TERM,
      s = v.getUint32(p, true),
      e =
        i + 1 < this.termCount
          ? v.getUint32(p + TERM, true)
          : this.docs - this.strings;
    if (s > e || this.strings + e > this.docs)
      throw new Error("Invalid dictionary");
    return {
      term: decoder.decode(
        this.bytes.subarray(this.strings + s, this.strings + e),
      ),
      df: v.getUint32(p + 4, true),
      object: v.getUint32(p + 8, true),
      offset: v.getUint32(p + 12, true),
      length: v.getUint32(p + 16, true),
      crc: v.getUint32(p + 20, true),
      positionObject: v.getUint32(p + 24, true),
      positionOffset: v.getUint32(p + 28, true),
      positionLength: v.getUint32(p + 32, true),
      positionCrc: v.getUint32(p + 36, true),
    };
  }
  lookup(term: string): Entry | undefined {
    let l = 0,
      r = this.termCount;
    while (l < r) {
      const m = (l + r) >>> 1,
        e = this.entry(m);
      if (e.term < term) l = m + 1;
      else if (e.term > term) r = m;
      else return e;
    }
  }
  document(i: number) {
    return this.documents.document(i);
  }
  lengths(i: number, out?: { body: number; title: number }) {
    return this.documents.lengths(i, out);
  }
  key(object: number, kind = "frequencies") {
    return `${this.generation}/${kind}-${object}.bin`;
  }
}
export function buildBinary(
  generation: string,
  entries: Entry[],
  documents: Uint8Array,
  documentCount: number,
  embedded: Uint8Array[],
  avgBody: number,
  avgTitle: number,
) {
  const terms = entries.map((e) => encoder.encode(e.term));
  const strings = HEADER + entries.length * TERM,
    docs = strings + terms.reduce((s, b) => s + b.length, 0),
    local = docs + documents.length;
  const b = new Uint8Array(local + embedded.reduce((s, x) => s + x.length, 0)),
    v = new DataView(b.buffer);
  for (const [p, n] of [
    [0, MAGIC],
    [4, VERSION],
    [8, b.length],
    [12, documentCount],
    [16, entries.length],
    [40, HEADER],
    [44, strings],
    [48, docs],
    [56, local],
  ])
    v.setUint32(p, n, true);
  v.setFloat64(24, avgBody, true);
  v.setFloat64(32, avgTitle, true);
  b.set(encoder.encode(generation), 64);
  let off = 0;
  entries.forEach((e, i) => {
    let p = HEADER + i * TERM;
    [
      off,
      e.df,
      e.object,
      e.offset,
      e.length,
      e.crc,
      e.positionObject,
      e.positionOffset,
      e.positionLength,
      e.positionCrc,
    ].forEach((n, j) => v.setUint32(p + j * 4, n, true));
    b.set(terms[i], strings + off);
    off += terms[i].length;
  });
  b.set(documents, docs);
  off = local;
  for (const x of embedded) {
    b.set(x, off);
    off += x.length;
  }
  return b;
}
