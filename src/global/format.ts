import {
  crc32,
  encoder,
  decoder,
  varint,
  readVarint,
} from "../format/codec.js";
export const GLOBAL_VERSION = 1,
  TILE_DOCS = 512,
  CHUNK_TOKENS = 512,
  MAX_RAW = 8 * 1048576;
export type Address = [number, number, number, number, number]; // object, offset, compressed bytes, CRC, raw bytes
export interface Row {
  doc: number;
  id: string;
  body: number;
  title: number;
  b: number;
  t: number;
  record: Address;
  passage: Address;
  first: number;
  bp?: number[];
  tp?: number[];
  chunks?: [number, Address][];
  recordData?: string;
  excerpt?: string;
}
export interface Block {
  tile: number;
  first: number;
  last: number;
  count: number;
  b: number;
  t: number;
  frequency: Address;
  positions: Address;
}
export interface Term {
  df: number;
  blocks: Block[];
  inline?: Uint8Array;
  inlinePositions?: Uint8Array;
  seeds?: Uint8Array;
  omitted: number;
  omittedDoc: number;
  windows?: [number, number][];
  windowDocs?: number;
}
export interface Root {
  version: 1;
  generation: string;
  count: number;
  avgBody: number;
  avgTitle: number;
  pageBytes: number;
  objectPages: number;
  dictionary: { first: string; last: string; address: Address }[];
  objects: { name: string; size: number; sha256: string }[];
  hotBytes: number;
}
class Writer {
  a: number[] = [];
  u(n: number) {
    varint(this.a, n);
  }
  text(s: string) {
    const b = encoder.encode(s);
    this.u(b.length);
    for (const x of b) this.a.push(x);
  }
  bytes(b: Uint8Array) {
    this.u(b.length);
    for (const x of b) this.a.push(x);
  }
  f(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    for (const x of b) this.a.push(x);
  }
  address(p: Address) {
    for (const n of p) this.u(n);
  }
  done() {
    return Uint8Array.from(this.a);
  }
}
class Reader {
  p = { i: 0 };
  constructor(readonly b: Uint8Array) {}
  u() {
    return readVarint(this.b, this.p);
  }
  bytes() {
    const n = this.u(),
      at = this.p.i;
    this.p.i += n;
    if (this.p.i > this.b.length) throw Error("Truncated global record");
    return this.b.subarray(at, at + n);
  }
  text() {
    return decoder.decode(this.bytes());
  }
  f() {
    if (this.p.i + 8 > this.b.length) throw Error("Truncated impact");
    const n = new DataView(
      this.b.buffer,
      this.b.byteOffset + this.p.i,
      8,
    ).getFloat64(0, true);
    this.p.i += 8;
    if (!Number.isFinite(n) || n < 0) throw Error("Invalid impact");
    return n;
  }
  address() {
    return Array.from({ length: 5 }, () => this.u()) as Address;
  }
  end() {
    if (this.p.i !== this.b.length) throw Error("Trailing global record");
  }
}
export function encodeRows(rows: Row[], positions = false, display = false) {
  const w = new Writer();
  w.u(positions ? 2 : display ? 3 : 1);
  w.u(rows.length);
  let doc = 0;
  for (const r of rows) {
    w.u(r.doc - doc);
    doc = r.doc;
    if (positions) {
      for (const a of [r.bp!, r.tp!]) {
        w.u(a.length);
        let prev = 0;
        for (const n of a) {
          w.u(n - prev);
          prev = n;
        }
      }
      w.u(r.chunks!.length);
      for (const [i, p] of r.chunks!) {
        w.u(i);
        w.address(p);
      }
    } else {
      w.text(r.id);
      w.u(r.body);
      w.u(r.title);
      w.f(r.b);
      w.f(r.t);
      w.address(r.record);
      w.address(r.passage);
      w.u(r.first);
      if (display) {
        w.text(r.recordData ?? "");
        w.text(r.excerpt ?? "");
      }
    }
  }
  return w.done();
}
export function decodeRows(b: Uint8Array, wanted?: Set<number>): Row[] {
  const r = new Reader(b),
    version = r.u(),
    count = r.u();
  if (![1, 2, 3].includes(version) || count > 512)
    throw Error("Global row version/count");
  const rows: Row[] = [];
  let doc = 0;
  for (let i = 0; i < count; i++) {
    const delta = r.u();
    if (i && !delta) throw Error("Unsorted global rows");
    doc += delta;
    if (version === 1 || version === 3) {
      rows.push({
        doc,
        id: r.text(),
        body: r.u(),
        title: r.u(),
        b: r.f(),
        t: r.f(),
        record: r.address(),
        passage: r.address(),
        first: r.u(),
      });
      if (version === 3) {
        const recordData = r.text(),
          excerpt = r.text();
        if (recordData) rows.at(-1)!.recordData = recordData;
        if (excerpt) rows.at(-1)!.excerpt = excerpt;
      }
    } else {
      const keep = !wanted || wanted.has(doc);
      const arrays: number[][] = [];
      for (let j = 0; j < 2; j++) {
        const a: number[] = [];
        let pos = 0;
        for (let k = 0, n = r.u(); k < n; k++) {
          const d = r.u();
          if (k && !d) throw Error("Unsorted global positions");
          pos += d;
          if (keep) a.push(pos);
        }
        arrays.push(a);
      }
      const chunks: [number, Address][] = [];
      for (let j = 0, n = r.u(); j < n; j++) {
        const chunk = r.u();
        if (keep) chunks.push([chunk, r.address()]);
        else for (let k = 0; k < 5; k++) r.u();
      }
      if (keep) rows.push({ doc, bp: arrays[0], tp: arrays[1], chunks } as Row);
    }
  }
  r.end();
  return rows;
}
export function encodeTerm(t: Term) {
  const w = new Writer();
  w.u(t.df);
  w.u(t.blocks.length);
  for (const b of t.blocks) {
    for (const n of [b.tile, b.first, b.last, b.count]) w.u(n);
    w.f(b.b);
    w.f(b.t);
    w.address(b.frequency);
    w.address(b.positions);
  }
  w.bytes(t.inline ?? new Uint8Array());
  w.bytes(t.inlinePositions ?? new Uint8Array());
  w.bytes(t.seeds ?? new Uint8Array());
  w.f(t.omitted);
  w.u(t.omittedDoc);
  if (t.windows) {
    w.u(t.windows.length);
    for (const [cell, bound] of t.windows) {
      w.u(cell);
      w.f(bound);
    }
  }
  if (t.windowDocs !== undefined) {
    if (!t.windows || ![8, 16, 32, 64].includes(t.windowDocs))
      throw Error("Invalid score window geometry");
    w.u(t.windowDocs);
  }
  return w.done();
}
export function decodeTerm(b: Uint8Array) {
  const r = new Reader(b);
  const t: Term = { df: r.u(), blocks: [], omitted: 0, omittedDoc: 0 };
  for (let i = 0, n = r.u(); i < n; i++) {
    const block: Block = {
      tile: r.u(),
      first: r.u(),
      last: r.u(),
      count: r.u(),
      b: r.f(),
      t: r.f(),
      frequency: r.address(),
      positions: r.address(),
    };
    if (
      block.first > block.last ||
      Math.floor(block.first / TILE_DOCS) !== block.tile ||
      Math.floor(block.last / TILE_DOCS) !== block.tile ||
      block.count < 1 ||
      block.count > 128
    )
      throw Error("Global block geometry");
    t.blocks.push(block);
  }
  t.inline = r.bytes();
  t.inlinePositions = r.bytes();
  t.seeds = r.bytes();
  t.omitted = r.f();
  t.omittedDoc = r.u();
  if (r.p.i < r.b.length) {
    t.windows = [];
    for (let i = 0, n = r.u(); i < n; i++) t.windows.push([r.u(), r.f()]);
  }
  if (r.p.i < r.b.length) {
    t.windowDocs = r.u();
    if (![8, 16, 32, 64].includes(t.windowDocs))
      throw Error("Invalid score window geometry");
  }
  r.end();
  return t;
}
// Front coding restarts every 16 terms; restart offsets permit bounded exact lookup.
export function encodeDictionary(entries: [string, Uint8Array][]) {
  const w = new Writer(),
    offsets: number[] = [];
  let previous = "";
  entries.forEach(([term, value], i) => {
    if (i % 16 === 0) {
      offsets.push(w.a.length);
      previous = "";
    }
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < term.length &&
      previous[prefix] === term[prefix]
    )
      prefix++; // UTF-16 prefix, UTF-8 suffix
    if (
      prefix &&
      prefix < term.length &&
      term.charCodeAt(prefix) >= 0xdc00 &&
      term.charCodeAt(prefix) <= 0xdfff
    )
      prefix--;
    w.u(prefix);
    w.text(term.slice(prefix));
    w.bytes(value);
    previous = term;
  });
  const payload = w.done(),
    out = new Uint8Array(8 + offsets.length * 4 + payload.length),
    v = new DataView(out.buffer);
  v.setUint32(0, entries.length, true);
  v.setUint32(4, offsets.length, true);
  offsets.forEach((n, i) => v.setUint32(8 + i * 4, n, true));
  out.set(payload, 8 + offsets.length * 4);
  return out;
}
export class Dictionary {
  private v: DataView;
  private base: number;
  readonly count: number;
  private restarts: number;
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < 8) throw Error("Truncated global dictionary");
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.count = this.v.getUint32(0, true);
    this.restarts = this.v.getUint32(4, true);
    this.base = 8 + this.restarts * 4;
    if (
      this.restarts !== Math.ceil(this.count / 16) ||
      this.base > bytes.length
    )
      throw Error("Global dictionary restarts");
  }
  private rows(block: number) {
    const r = new Reader(this.bytes.subarray(this.base));
    r.p.i = this.v.getUint32(8 + block * 4, true);
    return r;
  }
  private first(block: number) {
    const r = this.rows(block);
    if (r.u()) throw Error("Invalid restart prefix");
    return r.text();
  }
  *entries(): Generator<[string, Uint8Array]> {
    for (let block = 0; block < this.restarts; block++) {
      const r = this.rows(block);
      let previous = "";
      for (let i = 0; i < Math.min(16, this.count - block * 16); i++) {
        const prefix = r.u();
        if (prefix > previous.length) throw Error("Invalid dictionary prefix");
        const key = previous.slice(0, prefix) + r.text();
        yield [key, r.bytes()];
        previous = key;
      }
    }
  }
  lookup(term: string) {
    if (!this.restarts) return;
    let lo = 0,
      hi = this.restarts;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.first(m) <= term) lo = m + 1;
      else hi = m;
    }
    if (!lo) return;
    const block = lo - 1,
      r = this.rows(block);
    let previous = "";
    for (let i = 0; i < Math.min(16, this.count - block * 16); i++) {
      const prefix = r.u();
      if (prefix > previous.length) throw Error("Invalid dictionary prefix");
      const key = previous.slice(0, prefix) + r.text(),
        value = r.bytes();
      if (key === term) return value;
      if (key > term) return;
      previous = key;
    }
  }
}
export function encodeRoot(root: Root, hot: Uint8Array) {
  const json = encoder.encode(JSON.stringify(root)),
    out = new Uint8Array(20 + json.length + hot.length),
    v = new DataView(out.buffer);
  [0x31424c47, json.length, hot.length, crc32(json), crc32(hot)].forEach(
    (n, i) => v.setUint32(i * 4, n, true),
  );
  out.set(json, 20);
  out.set(hot, 20 + json.length);
  return out;
}
export function decodeRoot(b: Uint8Array) {
  if (b.length < 20) throw Error("Truncated global root");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    n = v.getUint32(4, true),
    m = v.getUint32(8, true);
  if (
    v.getUint32(0, true) !== 0x31424c47 ||
    b.length !== 20 + n + m ||
    crc32(b.subarray(20, 20 + n)) !== v.getUint32(12, true) ||
    crc32(b.subarray(20 + n)) !== v.getUint32(16, true)
  )
    throw Error("Global root checksum/version mismatch");
  const root: Root = JSON.parse(decoder.decode(b.subarray(20, 20 + n)));
  if (
    root.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(root.generation) ||
    ![65536, 131072, 262144].includes(root.pageBytes)
  )
    throw Error("Global root version/generation mismatch");
  return { root, hot: new Dictionary(b.subarray(20 + n)) };
}
