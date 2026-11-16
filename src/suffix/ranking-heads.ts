import type { SuffixBlock, SuffixColumn } from "./format.js";
import { canonicalBit } from "./format.js";

const MAGIC = 0x31485253,
  HEADER = 20,
  BLOCK_HEADER = 88;
const names = (length: number): SuffixColumn[] => [
  "documents",
  "positions",
  "flags",
  `score16-${length}`,
  `score8-${length}`,
];
export interface RankingHead {
  block: SuffixBlock;
  rows: Uint16Array;
  codes: Uint16Array;
  docs: Uint32Array;
  positions: Uint32Array;
  remainder: number;
  complete: boolean;
}

/** Bounded best-row summaries, not a candidate cutoff. The largest omitted
 * score code is retained so queries can prove completion or open the full block. */
export function encodeRankingHeads(
  blocks: SuffixBlock[],
  docs: Uint32Array,
  positions: Uint32Array,
  flags: Uint16Array,
  scores: Uint16Array[],
  limit = 32,
) {
  if (!blocks.length || limit < 1 || limit > 255 || blocks.length > 65535)
    throw Error("Invalid suffix ranking group");
  const result: Uint8Array[] = [];
  for (let p = 0; p < 4; p++) {
    const length = p + 2,
      raw = new Uint8Array(
        HEADER + blocks.length * (BLOCK_HEADER + limit * 12),
      ),
      v = new DataView(raw.buffer),
      code = scores[p];
    v.setUint32(0, MAGIC, true);
    v.setUint8(8, length);
    v.setUint8(9, limit);
    v.setUint16(10, blocks.length, true);
    v.setUint32(12, blocks[0].first, true);
    v.setUint32(16, blocks.at(-1)!.first + blocks.at(-1)!.count, true);
    let at = HEADER,
      base = 0;
    for (const b of blocks) {
      const heap = new Uint16Array(limit),
        bit = canonicalBit(length, "all");
      let count = 0,
        total = 0,
        remainder = 0;
      const worse = (a: number, b: number) =>
        code[base + a] < code[base + b] ||
        (code[base + a] === code[base + b] &&
          (docs[base + a] > docs[base + b] ||
            (docs[base + a] === docs[base + b] && a > b)));
      for (let row = 0; row < b.count; row++) {
        if (!(flags[base + row] & bit)) continue;
        total++;
        if (count < limit) {
          let i = count++;
          heap[i] = row;
          while (i) {
            const parent = (i - 1) >>> 1;
            if (!worse(heap[i], heap[parent])) break;
            [heap[i], heap[parent]] = [heap[parent], heap[i]];
            i = parent;
          }
        } else if (worse(heap[0], row)) {
          remainder = Math.max(remainder, code[base + heap[0]]);
          heap[0] = row;
          let i = 0;
          while (i * 2 + 1 < count) {
            let c = i * 2 + 1;
            if (c + 1 < count && worse(heap[c + 1], heap[c])) c++;
            if (!worse(heap[c], heap[i])) break;
            [heap[c], heap[i]] = [heap[i], heap[c]];
            i = c;
          }
        } else remainder = Math.max(remainder, code[base + row]);
      }
      const selected = heap
        .subarray(0, count)
        .sort(
          (a, b) =>
            code[base + b] - code[base + a] ||
            docs[base + a] - docs[base + b] ||
            a - b,
        );
      v.setUint32(at, b.first, true);
      v.setUint32(at + 4, b.count, true);
      v.setFloat64(at + 8, b.scoreMaximum[p], true);
      v.setUint32(at + 16, b.minDocument, true);
      v.setUint16(at + 20, count, true);
      v.setUint16(at + 22, remainder, true);
      v.setUint8(at + 24, Number(total <= limit));
      names(length).forEach((name, i) => {
        const r = b.columns[name];
        v.setFloat64(at + 28 + i * 12, r.offset, true);
        v.setUint32(at + 36 + i * 12, r.length, true);
      });
      at += BLOCK_HEADER;
      for (const row of selected) {
        v.setUint16(at, row, true);
        v.setUint16(at + 2, code[base + row], true);
        v.setUint32(at + 4, docs[base + row], true);
        v.setUint32(at + 8, positions[base + row], true);
        at += 12;
      }
      base += b.count;
    }
    if (
      base !== docs.length ||
      positions.length !== base ||
      flags.length !== base ||
      code.length !== base
    )
      throw Error("Suffix ranking column coverage mismatch");
    v.setUint32(4, at, true);
    result.push(raw.slice(0, at));
  }
  return result;
}

export function decodeRankingHeads(
  raw: Uint8Array,
  length: number,
  first: number,
  end: number,
) {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (
    raw.length < HEADER ||
    v.getUint32(0, true) !== MAGIC ||
    v.getUint32(4, true) !== raw.length ||
    v.getUint8(8) !== length ||
    v.getUint32(12, true) !== first ||
    v.getUint32(16, true) !== end
  )
    throw Error("Invalid suffix ranking group");
  const result: RankingHead[] = [],
    limit = v.getUint8(9),
    blocks = v.getUint16(10, true);
  let at = HEADER,
    expected = first;
  for (let i = 0; i < blocks; i++) {
    if (at + BLOCK_HEADER > raw.length)
      throw Error("Truncated suffix ranking block");
    const start = v.getUint32(at, true),
      count = v.getUint32(at + 4, true),
      max = v.getFloat64(at + 8, true),
      n = v.getUint16(at + 20, true),
      remainder = v.getUint16(at + 22, true),
      complete = v.getUint8(at + 24),
      columns = {} as SuffixBlock["columns"];
    if (
      start !== expected ||
      !count ||
      count > 4096 ||
      n > limit ||
      n > count ||
      complete > 1 ||
      !Number.isFinite(max) ||
      max < 0 ||
      at + BLOCK_HEADER + n * 12 > raw.length
    )
      throw Error("Invalid suffix ranking block");
    names(length).forEach((name, j) => {
      const offset = v.getFloat64(at + 28 + j * 12, true),
        bytes = v.getUint32(at + 36 + j * 12, true);
      if (!Number.isSafeInteger(offset) || offset < 0 || !bytes)
        throw Error("Invalid suffix ranking reference");
      columns[name] = { offset, length: bytes };
    });
    const scoreMaximum = [0, 0, 0, 0];
    scoreMaximum[length - 2] = max;
    const block: SuffixBlock = {
        first: start,
        count,
        low: [],
        high: [],
        columns,
        scoreMaximum,
        minDocument: v.getUint32(at + 16, true),
      },
      rows = new Uint16Array(n),
      codes = new Uint16Array(n),
      docs = new Uint32Array(n),
      positions = new Uint32Array(n);
    at += BLOCK_HEADER;
    for (let j = 0; j < n; j++) {
      rows[j] = v.getUint16(at, true);
      codes[j] = v.getUint16(at + 2, true);
      docs[j] = v.getUint32(at + 4, true);
      positions[j] = v.getUint32(at + 8, true);
      if (rows[j] >= count) throw Error("Invalid suffix ranking row");
      at += 12;
    }
    result.push({
      block,
      rows,
      codes,
      docs,
      positions,
      remainder,
      complete: !!complete,
    });
    expected = start + count;
  }
  if (at !== raw.length || expected !== end)
    throw Error("Suffix ranking group coverage mismatch");
  return result;
}
