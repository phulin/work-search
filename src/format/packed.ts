import type { Posting, DecodedPostings } from "./codec.js";
const MAGIC = 0x38465250;
// Constant columns and bit-packed columns compete against the legacy varints.
export function encodePacked(rows: Posting[]): Uint8Array {
  const columns = [
    rows.map((r, i) =>
      i ? r.doc - rows[i - 1].doc : rows.length > 1 ? rows[1].doc - r.doc : 0,
    ),
    rows.map((r) => r.body),
    rows.map((r) => r.title),
  ];
  const chunks = columns.map((values) => {
    if (values.every((v) => v === values[0])) {
      const b = new Uint8Array(5);
      b[0] = 64;
      new DataView(b.buffer).setUint32(1, values[0], true);
      return b;
    }
    const width = 32 - Math.clz32(Math.max(...values));
    const b = new Uint8Array(1 + Math.ceil((values.length * width) / 8));
    b[0] = width;
    for (let i = 0; i < values.length; i++) {
      let value = values[i],
        bit = i * width,
        left = width;
      while (left) {
        const at = 1 + Math.floor(bit / 8),
          shift = bit % 8,
          n = Math.min(8 - shift, left);
        b[at] |= (value % 2 ** n) << shift;
        value = Math.floor(value / 2 ** n);
        bit += n;
        left -= n;
      }
    }
    return b;
  });
  const b = new Uint8Array(12 + chunks.reduce((s, c) => s + c.length, 0)),
    v = new DataView(b.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, rows.length, true);
  v.setUint32(8, rows[0].doc, true);
  let offset = 12;
  for (const c of chunks) {
    b.set(c, offset);
    offset += c.length;
  }
  return b;
}
export function decodePacked(
  b: Uint8Array,
  result: DecodedPostings,
  row: number,
  count: number,
): boolean {
  if (
    b.length < 4 ||
    new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) !==
      MAGIC
  )
    return false;
  if (b.length < 12) throw new Error("Truncated packed header");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(4, true) !== count) throw new Error("Packed count mismatch");
  let offset = 12;
  for (const [column, out] of [
    result.docs,
    result.body,
    result.title,
  ].entries()) {
    if (offset >= b.length) throw new Error("Truncated packed column");
    const width = b[offset++];
    let constant: number | undefined;
    if (width === 64) {
      if (offset + 4 > b.length) throw new Error("Truncated constant");
      constant = v.getUint32(offset, true);
      offset += 4;
    } else if (width > 32) throw new Error("Invalid bit width");
    const length = constant === undefined ? Math.ceil((count * width) / 8) : 0;
    if (offset + length > b.length) throw new Error("Truncated packed data");
    let doc = v.getUint32(8, true);
    if (constant !== undefined) {
      if (column > 0) out.fill(constant, row, row + count);
      else {
        if (count > 1 && !constant) throw new Error("Unsorted packed postings");
        for (let i = 0; i < count; i++) {
          const value = doc + i * constant;
          if (value > 0xffffffff) throw new Error("Document overflow");
          out[row + i] = value;
        }
      }
      continue;
    }
    for (let i = 0; i < count; i++) {
      let value = constant ?? 0;
      if (constant === undefined) {
        if (width === 1) value = (b[offset + (i >>> 3)] >>> (i & 7)) & 1;
        else {
          let bit = i * width,
            left = width,
            mult = 1;
          while (left) {
            const at = offset + Math.floor(bit / 8),
              shift = bit % 8,
              n = Math.min(8 - shift, left);
            value += ((b[at] >>> shift) & (2 ** n - 1)) * mult;
            mult *= 2 ** n;
            bit += n;
            left -= n;
          }
        }
      }
      if (column === 0) {
        if (i > 0 && !value) throw new Error("Unsorted packed postings");
        if (i) doc += value;
        if (doc > 0xffffffff) throw new Error("Document overflow");
        out[row + i] = doc;
      } else out[row + i] = value;
    }
    offset += length;
  }
  if (offset !== b.length) throw new Error("Trailing packed data");
  for (let i = row; i < row + count; i++)
    if (!result.body[i] && !result.title[i]) throw new Error("Empty frequency");
  return true;
}
