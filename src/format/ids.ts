import { encoder, decoder, varint, readVarint, crc32 } from "./codec.js";
const MAGIC = 0x31534449,
  BLOCK = 32;
/** UTF-8 front coding with independent 32-ID restart blocks. No per-ID objects. */
export function encodeIds(count: number, id: (i: number) => string) {
  const chunks: Uint8Array[] = [];
  for (let first = 0; first < count; first += BLOCK) {
    const out: number[] = [];
    let previous = new Uint8Array(0);
    for (let i = first; i < Math.min(count, first + BLOCK); i++) {
      const b = encoder.encode(id(i));
      let p = 0;
      while (p < Math.min(previous.length, b.length) && previous[p] === b[p])
        p++;
      varint(out, p);
      varint(out, b.length - p);
      for (let j = p; j < b.length; j++) out.push(b[j]);
      previous = b;
    }
    chunks.push(Uint8Array.from(out));
  }
  const start = 16 + (chunks.length + 1) * 4,
    out = new Uint8Array(start + chunks.reduce((n, b) => n + b.length, 0)),
    v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, count, true);
  v.setUint32(8, BLOCK, true);
  v.setUint32(12, chunks.length, true);
  let p = start;
  chunks.forEach((b, i) => {
    v.setUint32(16 + i * 4, p, true);
    out.set(b, p);
    p += b.length;
  });
  v.setUint32(16 + chunks.length * 4, p, true);
  return out;
}
export class IdTable {
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    readonly count: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blocks = Math.ceil(count / BLOCK),
      v = this.view,
      start = 16 + (blocks + 1) * 4;
    if (
      bytes.length < start ||
      v.getUint32(0, true) !== MAGIC ||
      v.getUint32(4, true) !== count ||
      v.getUint32(8, true) !== BLOCK ||
      v.getUint32(12, true) !== blocks ||
      v.getUint32(16, true) !== start ||
      v.getUint32(16 + blocks * 4, true) !== bytes.length
    )
      throw Error("Invalid ID table");
    for (let i = 0; i < blocks; i++)
      if (v.getUint32(16 + i * 4, true) >= v.getUint32(20 + i * 4, true))
        throw Error("Invalid ID restart");
  }
  get(doc: number) {
    if (!Number.isInteger(doc) || doc < 0 || doc >= this.count)
      throw Error("ID out of range");
    const block = Math.floor(doc / BLOCK),
      v = this.view,
      b = this.bytes.subarray(
        v.getUint32(16 + block * 4, true),
        v.getUint32(20 + block * 4, true),
      ),
      p = { i: 0 };
    let previous = new Uint8Array(0);
    for (let j = block * BLOCK; j <= doc; j++) {
      const prefix = readVarint(b, p),
        len = readVarint(b, p);
      if (prefix > previous.length || p.i + len > b.length)
        throw Error("Invalid ID prefix");
      const next = new Uint8Array(prefix + len);
      next.set(previous.subarray(0, prefix));
      next.set(b.subarray(p.i, p.i + len), prefix);
      p.i += len;
      previous = next;
    }
    return decoder.decode(previous);
  }
}
