import { readVarint, type DecodedPostings } from "./codec.js";
import type { Block } from "./blocks.js";
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  return c >>> 0;
});
function checksum(
  bytes: Uint8Array,
  start: number,
  end: number,
  expected: number,
) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ table[(c ^ bytes[i]) & 255];
  if ((c ^ 0xffffffff) >>> 0 !== expected)
    throw new Error("Block checksum mismatch");
}
// Decode directly into final arrays. Bounds-limited views are essential: a
// corrupt varint must not consume bytes from the next independently valid block.
export function decodeBlockInto(
  frequency: Uint8Array,
  fstart: number,
  block: Block,
  result: DecodedPostings,
  row: number,
  positions?: Uint8Array,
  pstart = 0,
  positionBase = 0,
) {
  const fend = fstart + block.length;
  if (fstart < 0 || fend > frequency.length)
    throw new Error("Invalid frequency block range");
  checksum(frequency, fstart, fend, block.crc);
  const f = frequency.subarray(fstart, fend),
    cursor = { i: 0 };
  if (
    readVarint(f, cursor) !== block.count ||
    row + block.count > result.docs.length
  )
    throw new Error("Invalid posting count");
  let doc = 0;
  const end = row + block.count;
  for (let i = row; i < end; i++) {
    const gap = readVarint(f, cursor);
    if (i > row && !gap) throw new Error("Unsorted postings");
    doc += gap;
    if (doc > 0xffffffff) throw new Error("Document overflow");
    result.docs[i] = doc;
    const body = readVarint(f, cursor),
      title = readVarint(f, cursor);
    if (!body && !title) throw new Error("Empty frequency");
    result.body[i] = body;
    result.title[i] = title;
  }
  if (cursor.i !== f.length) throw new Error("Trailing frequency data");
  if (result.docs[row] !== block.first || doc !== block.last)
    throw new Error("Block skip boundary mismatch");
  if (!positions) return;
  const pend = pstart + block.positionLength;
  if (pstart < 0 || pend > positions.length || !result.positionOffsets)
    throw new Error("Invalid position block range");
  checksum(positions, pstart, pend, block.positionCrc);
  const p = positions.subarray(pstart, pend);
  cursor.i = 0;
  if (readVarint(p, cursor) !== block.count || cursor.i + 4 > p.length)
    throw new Error("Invalid position count");
  const i = cursor.i;
  const bound =
    (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
  cursor.i += 4;
  if (bound !== block.crc)
    throw new Error("Frequency/position stream mismatch");
  for (let rowIndex = row; rowIndex < end; rowIndex++) {
    result.positionOffsets[rowIndex] = positionBase + pstart + cursor.i;
    const body = result.body[rowIndex],
      title = result.title[rowIndex];
    if (body + title > p.length - cursor.i)
      throw new Error("Invalid position count");
    // No per-row [body,title] arrays or temporary per-block offset tables.
    for (let field = 0; field < 2; field++) {
      const count = field ? title : body;
      let value = 0;
      for (let j = 0; j < count; j++) {
        const delta = readVarint(p, cursor);
        if (j && !delta) throw new Error("Unsorted positions");
        value += delta;
        if (value > 0xffffffff) throw new Error("Position overflow");
      }
    }
  }
  if (cursor.i !== p.length) throw new Error("Trailing position data");
}
