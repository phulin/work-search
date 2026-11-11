import { crc32, decoder, encoder, readVarint, varint } from "./codec.js";

export interface StoredDocument {
  id: string;
  body: number;
  title: number;
  metaObject: number;
  metaOffset: number;
  metaLength: number;
}
export const DOCUMENT_BLOCK_SIZE = 32;
const MAGIC = 0x32435444,
  HEADER = 16,
  BLOCK_HEADER = 20;
const packedSize = (n: number, width: number) => Math.ceil((n * width) / 8);
function uint(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
    throw new Error("Invalid document integer");
}
function width(n: number) {
  return n === 0 ? 0 : 32 - Math.clz32(n);
}
function pack(values: number[], bits: number, base: number): Uint8Array {
  const out = new Uint8Array(packedSize(values.length, bits));
  values.forEach((value, i) => {
    let bit = i * bits,
      remaining = bits,
      delta = value - base;
    while (remaining) {
      const take = Math.min(8 - (bit % 8), remaining);
      out[bit >>> 3] |= (delta % 2 ** take) * 2 ** (bit % 8);
      delta = Math.floor(delta / 2 ** take);
      remaining -= take;
      bit += take;
    }
  });
  return out;
}
function unpack(
  bytes: Uint8Array,
  start: number,
  i: number,
  bits: number,
): number {
  if (bits === 0) return 0;
  const bit = i * bits,
    offset = start + (bit >>> 3),
    shift = bit & 7,
    span = bits + shift;
  // Read only the required bytes, including the fifth byte for unaligned u32s.
  let value = bytes[offset];
  if (span > 8) value |= bytes[offset + 1] << 8;
  if (span > 16) value |= bytes[offset + 2] << 16;
  if (span > 24) value |= bytes[offset + 3] << 24;
  value = value >>> shift;
  if (span > 32)
    value += (bytes[offset + 4] & ((1 << (span - 32)) - 1)) * 2 ** (32 - shift);
  return bits === 32 ? value : (value & (0xffffffff >>> (32 - bits))) >>> 0;
}

/** Independent restart blocks: constant-time lengths, bounded ID/pointer decoding. */
export function encodeDocuments(documents: StoredDocument[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (let first = 0; first < documents.length; first += DOCUMENT_BLOCK_SIZE) {
    const docs = documents.slice(first, first + DOCUMENT_BLOCK_SIZE);
    for (const d of docs)
      for (const n of [
        d.body,
        d.title,
        d.metaObject,
        d.metaOffset,
        d.metaLength,
      ])
        uint(n);
    const body = docs.map((d) => d.body),
      title = docs.map((d) => d.title);
    const bodyMin = Math.min(...body),
      titleMin = Math.min(...title);
    const bw = width(Math.max(...body) - bodyMin),
      tw = width(Math.max(...title) - titleMin);
    const records: number[] = [];
    let previous = new Uint8Array(0),
      object = docs[0].metaObject,
      offset = docs[0].metaOffset;
    for (const d of docs) {
      const id = encoder.encode(d.id);
      let prefix = 0;
      while (
        prefix < previous.length &&
        prefix < id.length &&
        previous[prefix] === id[prefix]
      )
        prefix++;
      varint(records, prefix);
      varint(records, id.length - prefix);
      for (let i = prefix; i < id.length; i++) records.push(id[i]);
      // A zero tag means the next contiguous record; exceptions carry absolute pointers.
      if (d.metaObject === object && d.metaOffset === offset)
        varint(records, 0);
      else {
        varint(records, 1);
        varint(records, d.metaObject);
        varint(records, d.metaOffset);
      }
      varint(records, d.metaLength);
      object = d.metaObject;
      offset = d.metaOffset + d.metaLength;
      uint(offset);
      previous = id;
    }
    const b = pack(body, bw, bodyMin),
      t = pack(title, tw, titleMin);
    const block = new Uint8Array(
        BLOCK_HEADER + b.length + t.length + records.length,
      ),
      v = new DataView(block.buffer);
    v.setUint32(0, bodyMin, true);
    v.setUint32(4, titleMin, true);
    v.setUint8(8, bw);
    v.setUint8(9, tw);
    v.setUint16(10, docs.length, true);
    v.setUint32(12, docs[0].metaObject, true);
    v.setUint32(16, docs[0].metaOffset, true);
    block.set(b, BLOCK_HEADER);
    block.set(t, BLOCK_HEADER + b.length);
    block.set(records, BLOCK_HEADER + b.length + t.length);
    blocks.push(block);
  }
  const dataStart = HEADER + (blocks.length + 1) * 4 + blocks.length * 4;
  const out = new Uint8Array(
      dataStart + blocks.reduce((s, b) => s + b.length, 0),
    ),
    v = new DataView(out.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, DOCUMENT_BLOCK_SIZE, true);
  v.setUint32(8, documents.length, true);
  v.setUint32(12, blocks.length, true);
  let offset = dataStart;
  blocks.forEach((b, i) => {
    v.setUint32(HEADER + i * 4, offset, true);
    v.setUint32(HEADER + (blocks.length + 1) * 4 + i * 4, crc32(b), true);
    out.set(b, offset);
    offset += b.length;
  });
  v.setUint32(HEADER + blocks.length * 4, offset, true);
  return out;
}

export class DocumentTable {
  readonly view: DataView;
  readonly blocks: number;
  readonly validated: Uint8Array;
  // One header, not a per-document or per-block decompressed cache. Candidates
  // are sorted, so adjacent documents usually reuse these scalar fields.
  private lengthBlock = -1;
  private bodyBase = 0;
  private titleBase = 0;
  private bodyBits = 0;
  private titleBits = 0;
  private bodyStart = 0;
  private titleStart = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly count: number,
  ) {
    if (bytes.length < HEADER) throw new Error("Truncated document table");
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    this.blocks = Math.ceil(count / DOCUMENT_BLOCK_SIZE);
    const dataStart = HEADER + (this.blocks + 1) * 4 + this.blocks * 4;
    if (
      v.getUint32(0, true) !== MAGIC ||
      v.getUint32(4, true) !== DOCUMENT_BLOCK_SIZE ||
      v.getUint32(8, true) !== count ||
      v.getUint32(12, true) !== this.blocks ||
      dataStart > bytes.length ||
      v.getUint32(HEADER, true) !== dataStart ||
      v.getUint32(HEADER + this.blocks * 4, true) !== bytes.length
    )
      throw new Error("Invalid document table");
    this.validated = new Uint8Array(Math.ceil(this.blocks / 8));
  }
  private block(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= this.count)
      throw new Error("Document out of range");
    const block = Math.floor(i / DOCUMENT_BLOCK_SIZE),
      v = this.view;
    const start = v.getUint32(HEADER + block * 4, true),
      end = v.getUint32(HEADER + (block + 1) * 4, true);
    const dataStart = HEADER + (this.blocks + 1) * 4 + this.blocks * 4;
    if (
      start < dataStart ||
      end > this.bytes.length ||
      end - start < BLOCK_HEADER
    )
      throw new Error("Invalid document block range");
    if (!(this.validated[block >>> 3] & (1 << (block & 7)))) {
      const crc = v.getUint32(HEADER + (this.blocks + 1) * 4 + block * 4, true);
      if (crc32(this.bytes.subarray(start, end)) !== crc)
        throw new Error("Document block checksum mismatch");
      const n = Math.min(
          DOCUMENT_BLOCK_SIZE,
          this.count - block * DOCUMENT_BLOCK_SIZE,
        ),
        bw = v.getUint8(start + 8),
        tw = v.getUint8(start + 9);
      if (
        v.getUint16(start + 10, true) !== n ||
        bw > 32 ||
        tw > 32 ||
        start + BLOCK_HEADER + packedSize(n, bw) + packedSize(n, tw) > end
      )
        throw new Error("Invalid document block");
      this.validated[block >>> 3] |= 1 << (block & 7);
    }
    return {
      start,
      end,
      n: Math.min(
        DOCUMENT_BLOCK_SIZE,
        this.count - block * DOCUMENT_BLOCK_SIZE,
      ),
      i: i % DOCUMENT_BLOCK_SIZE,
    };
  }
  lengths(i: number, out = { body: 0, title: 0 }) {
    if (!Number.isInteger(i) || i < 0 || i >= this.count)
      throw new Error("Document out of range");
    const block = i >>> 5;
    if (block !== this.lengthBlock) {
      const b = this.block(i),
        v = this.view;
      this.bodyBase = v.getUint32(b.start, true);
      this.titleBase = v.getUint32(b.start + 4, true);
      this.bodyBits = v.getUint8(b.start + 8);
      this.titleBits = v.getUint8(b.start + 9);
      this.bodyStart = b.start + BLOCK_HEADER;
      this.titleStart = this.bodyStart + packedSize(b.n, this.bodyBits);
      this.lengthBlock = block;
    }
    const local = i & 31;
    const body =
      this.bodyBase +
      (this.bodyBits === 0
        ? 0
        : unpack(this.bytes, this.bodyStart, local, this.bodyBits));
    const title =
      this.titleBase +
      (this.titleBits === 0
        ? 0
        : unpack(this.bytes, this.titleStart, local, this.titleBits));
    if (body > 0xffffffff || title > 0xffffffff)
      throw new Error("Invalid document integer");
    out.body = body;
    out.title = title;
    return out;
  }
  document(i: number): StoredDocument {
    const b = this.block(i),
      v = this.view,
      bytes = this.bytes.subarray(b.start, b.end);
    const p = {
      i:
        BLOCK_HEADER +
        packedSize(b.n, v.getUint8(b.start + 8)) +
        packedSize(b.n, v.getUint8(b.start + 9)),
    };
    let previous = new Uint8Array(0),
      object = v.getUint32(b.start + 12, true),
      offset = v.getUint32(b.start + 16, true);
    for (let j = 0; j <= b.i; j++) {
      const prefix = readVarint(bytes, p),
        suffix = readVarint(bytes, p);
      if (prefix > previous.length || suffix > bytes.length - p.i)
        throw new Error("Invalid front-coded ID");
      const id = new Uint8Array(prefix + suffix);
      id.set(previous.subarray(0, prefix));
      id.set(bytes.subarray(p.i, p.i + suffix), prefix);
      p.i += suffix;
      const tag = readVarint(bytes, p);
      if (tag === 1) {
        object = readVarint(bytes, p);
        offset = readVarint(bytes, p);
      } else if (tag !== 0) throw new Error("Invalid metadata pointer tag");
      const length = readVarint(bytes, p);
      uint(offset + length);
      if (j === b.i) {
        if (j === b.n - 1 && p.i !== bytes.length)
          throw new Error("Trailing document data");
        return {
          id: decoder.decode(id),
          ...this.lengths(i),
          metaObject: object,
          metaOffset: offset,
          metaLength: length,
        };
      }
      offset += length;
      previous = id;
    }
    throw new Error("Invalid document");
  }
}
