import {
  crc32,
  encodeFrequencies,
  encodePositions,
  type Posting,
} from "./codec.js";
// Small lists retain the compact v4 streams. Large lists restart every 256 docs.
export const BLOCK_SIZE = 256,
  BLOCK_HEADER = 16,
  BLOCK_ENTRY = 36;
const MAGIC = 0x354b4c42;
export const directoryLength = (df: number) =>
  BLOCK_HEADER + Math.ceil(df / BLOCK_SIZE) * BLOCK_ENTRY;
export interface Block {
  first: number;
  last: number;
  offset: number;
  length: number;
  crc: number;
  positionOffset: number;
  positionLength: number;
  positionCrc: number;
  count: number;
}
export function encodeBlocks(list: Posting[]) {
  if (list.length <= BLOCK_SIZE) {
    const frequencies = encodeFrequencies(list),
      crc = crc32(frequencies);
    return { frequencies, positions: encodePositions(list, crc), crc };
  }
  const directory = new Uint8Array(directoryLength(list.length)),
    v = new DataView(directory.buffer);
  [MAGIC, list.length, BLOCK_SIZE, Math.ceil(list.length / BLOCK_SIZE)].forEach(
    (n, i) => v.setUint32(i * 4, n, true),
  );
  const fs: Uint8Array[] = [],
    ps: Uint8Array[] = [];
  let f = directory.length,
    p = 0;
  for (let i = 0; i < list.length; i += BLOCK_SIZE) {
    const rows = list.slice(i, i + BLOCK_SIZE),
      frequency = encodeFrequencies(rows),
      crc = crc32(frequency),
      positions = encodePositions(rows, crc);
    [
      rows[0].doc,
      rows[rows.length - 1].doc,
      f,
      frequency.length,
      crc,
      p,
      positions.length,
      crc32(positions),
      rows.length,
    ].forEach((n, j) =>
      v.setUint32(
        BLOCK_HEADER + (i / BLOCK_SIZE) * BLOCK_ENTRY + j * 4,
        n,
        true,
      ),
    );
    fs.push(frequency);
    ps.push(positions);
    f += frequency.length;
    p += positions.length;
  }
  const frequencies = new Uint8Array(f),
    positions = new Uint8Array(p);
  frequencies.set(directory);
  f = directory.length;
  p = 0;
  for (let i = 0; i < fs.length; i++) {
    frequencies.set(fs[i], f);
    f += fs[i].length;
    positions.set(ps[i], p);
    p += ps[i].length;
  }
  return { frequencies, positions, crc: crc32(directory) };
}
export function decodeDirectory(
  bytes: Uint8Array,
  df: number,
  frequencyLength: number,
  positionLength: number,
  crc: number,
): Block[] {
  if (bytes.length !== directoryLength(df) || crc32(bytes) !== crc)
    throw new Error("Block directory checksum/length mismatch");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    n = Math.ceil(df / BLOCK_SIZE);
  if (
    v.getUint32(0, true) !== MAGIC ||
    v.getUint32(4, true) !== df ||
    v.getUint32(8, true) !== BLOCK_SIZE ||
    v.getUint32(12, true) !== n
  )
    throw new Error("Block directory version/count mismatch");
  let f = bytes.length,
    p = 0,
    last = -1;
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const a = Array.from({ length: 9 }, (_, j) =>
      v.getUint32(BLOCK_HEADER + i * BLOCK_ENTRY + j * 4, true),
    );
    const [
      first,
      end,
      offset,
      length,
      checksum,
      positionOffset,
      plen,
      pcrc,
      count,
    ] = a;
    if (
      first <= last ||
      end < first ||
      offset !== f ||
      positionOffset !== p ||
      count !== Math.min(BLOCK_SIZE, df - i * BLOCK_SIZE) ||
      !length ||
      !plen ||
      f + length > frequencyLength ||
      p + plen > positionLength
    )
      throw new Error("Invalid block geometry");
    blocks.push({
      first,
      last: end,
      offset,
      length,
      crc: checksum,
      positionOffset,
      positionLength: plen,
      positionCrc: pcrc,
      count,
    });
    f += length;
    p += plen;
    last = end;
  }
  if (f !== frequencyLength || p !== positionLength)
    throw new Error("Trailing block data");
  return blocks;
}
// Binary lower-bound seek skips blocks whose doc range contains no candidate.
export function selectBlocks(blocks: Block[], candidates?: Uint32Array) {
  if (!candidates) return blocks.map((_, i) => i);
  const selected: number[] = [];
  let row = 0;
  for (let i = 0; i < blocks.length && row < candidates.length; i++) {
    const b = blocks[i];
    if (candidates[row] > b.last) continue;
    let lo = row,
      hi = candidates.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (candidates[m] < b.first) lo = m + 1;
      else hi = m;
    }
    row = lo;
    if (row < candidates.length && candidates[row] <= b.last) selected.push(i);
  }
  return selected;
}
