export const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  return c >>> 0;
});
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (c >>> 8) ^ crcTable[(c ^ b) & 255];
  return (c ^ 0xffffffff) >>> 0;
}
export function varint(out: number[], n: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    throw new Error("Integer overflow");
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
export function readVarint(b: Uint8Array, p: { i: number }): number {
  let n = 0,
    mul = 1;
  for (let j = 0; j < 5; j++) {
    if (p.i >= b.length) throw new Error("Truncated varint");
    const x = b[p.i++];
    n += (x & 127) * mul;
    if (!(x & 128)) {
      if (n > 0xffffffff || (j > 0 && x === 0))
        throw new Error("Invalid varint");
      return n;
    }
    mul *= 128;
  }
  throw new Error("Invalid varint");
}
export interface Posting {
  doc: number;
  body: number;
  title: number;
}
export function encodePostings(list: Posting[]): Uint8Array {
  const out: number[] = [];
  varint(out, list.length);
  let prev = 0;
  for (const p of list) {
    if (p.doc < prev || (!p.body && !p.title))
      throw new Error("Invalid posting");
    varint(out, p.doc - prev);
    varint(out, p.body);
    varint(out, p.title);
    prev = p.doc;
  }
  return Uint8Array.from(out);
}
export function decodePostings(
  b: Uint8Array,
  expected?: number,
): { docs: Uint32Array; body: Uint32Array; title: Uint32Array } {
  const p = { i: 0 },
    n = readVarint(b, p);
  if (
    (expected !== undefined && n !== expected) ||
    n > Math.floor((b.length - p.i) / 3)
  )
    throw new Error("Invalid posting count");
  const docs = new Uint32Array(n),
    body = new Uint32Array(n),
    title = new Uint32Array(n);
  let doc = 0;
  for (let i = 0; i < n; i++) {
    const d = readVarint(b, p);
    if (i && d === 0) throw new Error("Unsorted postings");
    doc += d;
    if (doc > 0xffffffff) throw new Error("Document overflow");
    docs[i] = doc;
    body[i] = readVarint(b, p);
    title[i] = readVarint(b, p);
    if (!body[i] && !title[i]) throw new Error("Empty frequency");
  }
  if (p.i !== b.length) throw new Error("Trailing posting data");
  return { docs, body, title };
}
