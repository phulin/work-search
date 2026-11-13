// CWS1: immutable, independently addressed numeric streams. No gzip in postings.
export const PAGE = 256 * 1024,
  OBJECT = 64 * 1024 * 1024,
  BLOCK = 128;
export type Ref = [number, number, number];
export interface Branch {
  first: number;
  last: number;
  count: number;
  height: number;
  b: number;
  t: number;
  score: Ref;
  positions: Ref;
  locators: Ref;
}
export interface Term {
  id: number;
  df: number;
  tree: Branch;
}
export interface Root {
  format: "CWS1";
  generation: string;
  count: number;
  avgBody: number;
  avgTitle: number;
  corpusHash: string;
  documents: Ref[];
  dictionaries: { first: string; last: string; ref: Ref }[];
  dictionaryHeight?: number;
  hot: Record<string, Term>;
  objects: {
    name: string;
    size: number;
    sha256: string;
    checksums?: number[];
    key?: string;
  }[];
}
export interface PairRoot extends Pick<
  Root,
  "generation" | "objects" | "dictionaries" | "dictionaryHeight" | "hot"
> {
  format: "CWP1";
  baseGeneration: string;
  count: number;
  coverage: {
    vocabulary: number;
    pairs: number;
    documents: number;
    occurrences: number;
    budgetBytes: number;
  };
}
export const bytes = (a: ArrayBufferView) =>
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
export const view = (a: Uint8Array) =>
  new DataView(a.buffer, a.byteOffset, a.byteLength);
export function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}
export function u32(a: ArrayLike<number>) {
  return bytes(Uint32Array.from(a));
}
export function refAt(v: DataView, at: number): Ref {
  return [
    v.getUint32(at, true),
    v.getUint32(at + 4, true),
    v.getUint32(at + 8, true),
  ];
}
export function writeRef(v: DataView, at: number, ref: Ref) {
  for (let i = 0; i < 3; i++) v.setUint32(at + i * 4, ref[i], true);
}
// Bit packing with an explicit base/restart for every stream (including tails).
export function pack(a: ArrayLike<number>, delta = false) {
  const n = a.length,
    base = delta && n ? a[0] : 0;
  let max = 0,
    previous = base;
  for (let i = 0; i < n; i++) {
    if (
      !Number.isInteger(a[i]) ||
      a[i] < 0 ||
      a[i] > 0xffffffff ||
      (delta && a[i] < previous)
    )
      throw Error("Invalid packed integer");
    const x = delta ? a[i] - previous : a[i];
    max = Math.max(max, x);
    previous = a[i];
  }
  const width = max ? 32 - Math.clz32(max) : 0;
  const out = new Uint8Array(12 + Math.ceil((n * width) / 32) * 4),
    v = view(out);
  v.setUint32(0, n, true);
  v.setUint32(4, base, true);
  v.setUint8(8, width);
  v.setUint8(9, +delta);
  previous = base;
  for (let i = 0; i < n && width; i++) {
    const x = (delta ? a[i] - previous : a[i]) >>> 0,
      bit = i * width,
      at = 12 + (bit >>> 5) * 4,
      shift = bit & 31;
    v.setUint32(at, v.getUint32(at, true) | (x << shift), true);
    if (shift + width > 32)
      v.setUint32(
        at + 4,
        v.getUint32(at + 4, true) | (x >>> (32 - shift)),
        true,
      );
    previous = a[i];
  }
  return out;
}
export function unpack(data: Uint8Array): Uint32Array<ArrayBuffer> {
  const v = view(data);
  if (data.length < 12) throw Error("Truncated integer block");
  const n = v.getUint32(0, true),
    width = v.getUint8(8),
    delta = v.getUint8(9);
  if (
    width > 32 ||
    delta > 1 ||
    data.length !== 12 + Math.ceil((n * width) / 32) * 4
  )
    throw Error("Invalid integer block");
  const out = new Uint32Array(n),
    mask = width === 32 ? 0xffffffff : 2 ** width - 1;
  let previous = v.getUint32(4, true);
  for (let i = 0; i < n; i++) {
    const bit = i * width,
      at = 12 + (bit >>> 5) * 4,
      shift = bit & 31;
    let x = width ? v.getUint32(at, true) >>> shift : 0;
    if (shift + width > 32) x |= v.getUint32(at + 4, true) << (32 - shift);
    x = (x & mask) >>> 0;
    if (delta && previous + x > 0xffffffff)
      throw Error("Packed integer overflow");
    out[i] = delta ? previous + x : x;
    previous = out[i];
  }
  return out;
}
export function encodeBranches(a: Branch[]) {
  const out = new Uint8Array(a.length * 72),
    v = view(out);
  a.forEach((b, i) => {
    const p = i * 72;
    v.setUint32(p, b.first, true);
    v.setUint32(p + 4, b.last, true);
    v.setUint32(p + 8, b.count, true);
    v.setUint32(p + 12, b.height, true);
    v.setFloat64(p + 16, b.b, true);
    v.setFloat64(p + 24, b.t, true);
    writeRef(v, p + 32, b.score);
    writeRef(v, p + 44, b.positions);
    writeRef(v, p + 56, b.locators);
  });
  return out;
}
export function decodeBranches(a: Uint8Array) {
  if (!a.length || a.length % 72) throw Error("Invalid branch page");
  const v = view(a),
    out: Branch[] = [];
  for (let p = 0; p < a.length; p += 72)
    out.push({
      first: v.getUint32(p, true),
      last: v.getUint32(p + 4, true),
      count: v.getUint32(p + 8, true),
      height: v.getUint32(p + 12, true),
      b: v.getFloat64(p + 16, true),
      t: v.getFloat64(p + 24, true),
      score: refAt(v, p + 32),
      positions: refAt(v, p + 44),
      locators: refAt(v, p + 56),
    });
  return out;
}
export interface Scores {
  docs: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  b: DataView;
  t: DataView;
}
export function encodeScores(
  docs: number[],
  body: number[],
  title: number[],
  b: number[],
  t: number[],
) {
  const columns = [
    pack(docs, true),
    pack(body),
    pack(title),
    bytes(Float64Array.from(b)),
    bytes(Float64Array.from(t)),
  ];
  return concat([u32(columns.map((c) => c.length)), ...columns]);
}
export function decodeScores(a: Uint8Array): Scores {
  // Cached DataViews must own compact storage, rather than retaining a 256-KiB
  // physical page for every tiny scoring leaf after page-LRU eviction.
  a = Uint8Array.from(a);
  const v = view(a),
    columns: Uint8Array[] = [];
  let p = 20;
  for (let i = 0; i < 5; i++) {
    const n = v.getUint32(i * 4, true);
    columns.push(a.subarray(p, p + n));
    p += n;
  }
  if (p !== a.length) throw Error("Truncated scoring block");
  const docs = unpack(columns[0]),
    body = unpack(columns[1]),
    title = unpack(columns[2]);
  if (
    body.length !== docs.length ||
    title.length !== docs.length ||
    columns[3].length !== docs.length * 8 ||
    columns[4].length !== docs.length * 8
  )
    throw Error("Invalid scoring columns");
  if (
    !docs.length ||
    docs.length > BLOCK ||
    docs.some((d, i) => i > 0 && d <= docs[i - 1])
  )
    throw Error("Unsorted scoring documents");
  return { docs, body, title, b: view(columns[3]), t: view(columns[4]) };
}
export function lower(a: ArrayLike<number>, n: number) {
  let l = 0,
    r = a.length;
  while (l < r) {
    const m = (l + r) >>> 1;
    if (a[m] < n) l = m + 1;
    else r = m;
  }
  return l;
}
