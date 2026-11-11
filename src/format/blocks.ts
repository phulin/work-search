import { encodePacked } from "./packed.js";
import {
  crc32,
  readVarint,
  varint,
  encodeFrequencies,
  encodePositions,
  type Posting,
} from "./codec.js";
// Small lists retain the compact v4 streams. Large lists restart every 256 docs.
export const BLOCK_SIZE = 256,
  BLOCK_HEADER = 16,
  BLOCK_ENTRY = 36;
const MAGIC = 0x354b4c42;
export const directoryLength = (df: number, format = 5) =>
  BLOCK_HEADER + Math.ceil(df / BLOCK_SIZE) * (format >= 6 ? 52 : BLOCK_ENTRY);
export interface Block {
  bodyMax?: number;
  titleMax?: number;
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
export interface BlockStats {
  count: number;
  avgBody: number;
  avgTitle: number;
  packed?: boolean;
  seekPositions?: boolean;
  lengths: (doc: number) => { body: number; title: number };
}
export function encodeBlocks(list: Posting[], stats?: BlockStats) {
  if (list.length <= BLOCK_SIZE) {
    const frequencies = encodeFrequencies(list),
      crc = crc32(frequencies);
    return { frequencies, positions: encodePositions(list, crc), crc };
  }
  const directory = new Uint8Array(directoryLength(list.length, stats ? 6 : 5)),
    v = new DataView(directory.buffer);
  [
    stats ? 0x364b4c42 : MAGIC,
    list.length,
    BLOCK_SIZE,
    Math.ceil(list.length / BLOCK_SIZE),
  ].forEach((n, i) => v.setUint32(i * 4, n, true));
  const fs: Uint8Array[] = [],
    ps: Uint8Array[] = [];
  let f = directory.length,
    p = 0;
  for (let i = 0; i < list.length; i += BLOCK_SIZE) {
    const rows = list.slice(i, i + BLOCK_SIZE),
      frequency = chooseFrequency(rows, stats?.packed),
      crc = crc32(frequency),
      positions =
        stats?.seekPositions &&
        rows.reduce((sum, r) => sum + r.body + r.title, 0) > rows.length * 4
          ? encodeSeekPositions(rows, crc)
          : encodePositions(rows, crc);
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
        BLOCK_HEADER + (i / BLOCK_SIZE) * (stats ? 52 : BLOCK_ENTRY) + j * 4,
        n,
        true,
      ),
    );
    if (stats) {
      const idf = Math.log(
        1 + (stats.count - list.length + 0.5) / (list.length + 0.5),
      );
      let bodyMax = 0,
        titleMax = 0;
      for (const row of rows) {
        const d = stats.lengths(row.doc);
        const b = row.body
          ? (idf * (row.body * 2.2)) /
            (row.body +
              1.2 * (1 - 0.75 + (0.75 * d.body) / (stats.avgBody || 1)))
          : 0;
        const t = row.title
          ? (idf * (row.title * 2.2)) /
            (row.title +
              1.2 * (1 - 0.75 + (0.75 * d.title) / (stats.avgTitle || 1)))
          : 0;
        bodyMax = Math.max(bodyMax, b);
        titleMax = Math.max(titleMax, t);
      }
      const at = BLOCK_HEADER + (i / BLOCK_SIZE) * 52;
      v.setFloat64(at + 36, bodyMax, true);
      v.setFloat64(at + 44, titleMax, true);
    }
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
  const modern =
    bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) === 0x364b4c42;
  if (
    bytes.length !== directoryLength(df, modern ? 6 : 5) ||
    crc32(bytes) !== crc
  )
    throw new Error("Block directory checksum/length mismatch");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    n = Math.ceil(df / BLOCK_SIZE);
  if (
    v.getUint32(0, true) !== (modern ? 0x364b4c42 : MAGIC) ||
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
    const entry = BLOCK_HEADER + i * (modern ? 52 : BLOCK_ENTRY),
      first = v.getUint32(entry, true),
      end = v.getUint32(entry + 4, true),
      offset = v.getUint32(entry + 8, true),
      length = v.getUint32(entry + 12, true),
      checksum = v.getUint32(entry + 16, true),
      positionOffset = v.getUint32(entry + 20, true),
      plen = v.getUint32(entry + 24, true),
      pcrc = v.getUint32(entry + 28, true),
      count = v.getUint32(entry + 32, true);
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
    const bodyMax = modern ? v.getFloat64(entry + 36, true) : undefined;
    const titleMax = modern ? v.getFloat64(entry + 44, true) : undefined;
    if (
      modern &&
      ![bodyMax, titleMax].every((x) => Number.isFinite(x) && x! >= 0)
    )
      throw new Error("Invalid block impacts");
    blocks.push({
      bodyMax,
      titleMax,
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

// Per-document byte lengths make positional rows seekable without a token scan.
export function encodeSeekPositions(rows: Posting[], crc: number) {
  const payloads = rows.map((row) => {
    const b = encodePositions([row], crc),
      p = { i: 0 };
    readVarint(b, p);
    return b.subarray(p.i + 4);
  });
  const lengths: number[] = [];
  for (const b of payloads) varint(lengths, b.length);
  const out = new Uint8Array(
    12 + lengths.length + payloads.reduce((s, b) => s + b.length, 0),
  );
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x37534f50, true);
  v.setUint32(4, rows.length, true);
  v.setUint32(8, crc, true);
  out.set(lengths, 12);
  let offset = 12 + lengths.length;
  for (const b of payloads) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

function chooseFrequency(rows: Posting[], packed = false) {
  const legacy = encodeFrequencies(rows);
  if (!packed) return legacy;
  const bits = encodePacked(rows);
  return bits.length < legacy.length ? bits : legacy;
}
