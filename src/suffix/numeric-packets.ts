import type { SuffixBlock, SuffixColumn } from "./format.js";
const MAGIC = 0x314e5357,
  HEADER = 136,
  INDEX_MAGIC = 0x33445357,
  INDEX_HEADER = 56,
  RECORD = 12,
  RESTART = 64,
  ADDRESS = 40;
export const baseColumns: SuffixColumn[] = ["documents", "positions", "flags"];
export const numericColumns: SuffixColumn[] = [
  ...baseColumns,
  "score16-2",
  "score16-3",
  "score16-4",
  "score16-5",
];
const identity = (corpus: string) => {
  if (!/^[a-f0-9]{64}$/.test(corpus))
    throw Error("Invalid numeric corpus identity");
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(corpus.slice(i * 2, i * 2 + 2), 16),
  );
};
/** Small-interval packets duplicate only document, position and flag columns.
 * The independently compressed score columns retain their original storage. */
export function encodeNumericBase(block: SuffixBlock, columns: Uint8Array[]) {
  if (columns.length !== baseColumns.length)
    throw Error("Missing numeric base columns");
  const raw = new Uint8Array(
      HEADER + columns.reduce((n, b) => n + b.length, 0),
    ),
    v = new DataView(raw.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, block.first, true);
  v.setUint32(8, block.count, true);
  v.setUint32(12, block.minDocument, true);
  block.scoreMaximum.forEach((x, i) => {
    if (i < 4) v.setFloat64(16 + i * 8, x, true);
  });
  numericColumns.forEach((name, i) => {
    const r = block.columns[name];
    if (!r || !Number.isSafeInteger(r.offset) || r.offset < 0 || !r.length)
      throw Error("Invalid numeric base reference");
    v.setFloat64(48 + i * 12, r.offset, true);
    v.setUint32(56 + i * 12, r.length, true);
  });
  let at = HEADER;
  columns.forEach((c, i) => {
    if (c.length !== block.columns[baseColumns[i]].length)
      throw Error("Invalid numeric base frame");
    raw.set(c, at);
    at += c.length;
  });
  return raw;
}
export function decodeNumericBase(raw: Uint8Array, fence: SuffixBlock) {
  if (raw.length < HEADER) throw Error("Truncated numeric base");
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (
    v.getUint32(0, true) !== MAGIC ||
    v.getUint32(4, true) !== fence.first ||
    v.getUint32(8, true) !== fence.count
  )
    throw Error("Numeric base identity mismatch");
  const columns = { ...fence.columns },
    scoreMaximum = Array.from({ length: 4 }, (_, i) =>
      v.getFloat64(16 + i * 8, true),
    ),
    frames: Partial<Record<SuffixColumn, Uint8Array>> = {};
  let at = HEADER;
  if (scoreMaximum.some((x) => !Number.isFinite(x) || x < 0))
    throw Error("Invalid numeric score bounds");
  numericColumns.forEach((name, i) => {
    const offset = v.getFloat64(48 + i * 12, true),
      length = v.getUint32(56 + i * 12, true),
      old = fence.columns[name];
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !length ||
      (old && (old.offset !== offset || old.length !== length))
    )
      throw Error("Invalid numeric base column");
    columns[name] = { offset, length };
    if (i < 3) {
      if (at + length > raw.length) throw Error("Truncated numeric base frame");
      frames[name] = raw.subarray(at, at + length);
      at += length;
    }
  });
  if (at !== raw.length) throw Error("Numeric base length mismatch");
  return {
    block: {
      ...fence,
      columns,
      scoreMaximum,
      minDocument: v.getUint32(12, true),
    },
    frames,
  };
}
export class NumericDirectoryBuilder {
  readonly bytes: Uint8Array;
  private view: DataView;
  private base: number;
  private at = 0;
  private offset = 0;
  private scoreOffsets = [0, 0, 0, 0];
  private baseOffsets = [0, 0, 0];
  constructor(
    readonly count: number,
    corpus: string,
    readonly rows: number,
  ) {
    if (!Number.isInteger(count) || count < 1)
      throw Error("Invalid numeric block count");
    this.base = INDEX_HEADER + Math.ceil(count / RESTART) * ADDRESS;
    this.bytes = new Uint8Array(this.base + count * RECORD);
    this.view = new DataView(this.bytes.buffer);
    this.view.setUint32(0, INDEX_MAGIC, true);
    this.view.setUint32(4, count, true);
    this.view.setUint32(8, rows, true);
    this.bytes.set(identity(corpus), 16);
  }
  append(block: SuffixBlock, length: number) {
    if (
      this.at >= this.count ||
      !Number.isInteger(length) ||
      length < HEADER ||
      length > 0xffffffff
    )
      throw Error("Invalid numeric base length");
    if (
      length !==
      HEADER +
        baseColumns.reduce((n, name, i) => {
          const ref = block.columns[name];
          if (!ref || ref.offset !== this.baseOffsets[i])
            throw Error("Noncontiguous numeric base column");
          this.baseOffsets[i] += ref.length;
          return n + ref.length;
        }, 0)
    )
      throw Error("Numeric base length differs from columns");
    const restart = this.at % RESTART === 0,
      at = this.base + this.at * RECORD;
    if (restart) {
      const p = INDEX_HEADER + Math.floor(this.at / RESTART) * ADDRESS;
      this.view.setFloat64(p, this.offset, true);
      for (let j = 0; j < 4; j++)
        this.view.setFloat64(
          p + 8 + j * 8,
          block.columns[numericColumns[j + 3]].offset,
          true,
        );
    }
    this.view.setUint32(at, length, true);
    for (let j = 0; j < 4; j++) {
      const r = block.columns[numericColumns[j + 3]];
      if (
        !r ||
        r.length > 65535 ||
        r.length < 1 ||
        (!restart && r.offset !== this.scoreOffsets[j])
      )
        throw Error("Invalid numeric score extent");
      this.view.setUint16(at + 4 + j * 2, r.length, true);
      this.scoreOffsets[j] = r.offset + r.length;
    }
    this.offset += length;
    this.at++;
  }
  finish() {
    if (this.at !== this.count) throw Error("Incomplete numeric directory");
    this.view.setFloat64(48, this.offset, true);
    return this.bytes;
  }
}
export class NumericDirectory {
  private view: DataView;
  private base: number;
  readonly count: number;
  readonly sourceBytes: number;
  constructor(
    readonly bytes: Uint8Array,
    corpus: string,
    rows: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < INDEX_HEADER ||
      this.view.getUint32(0, true) !== INDEX_MAGIC ||
      this.view.getUint32(8, true) !== rows ||
      identity(corpus).some((x, i) => x !== bytes[16 + i])
    )
      throw Error("Invalid numeric directory");
    this.count = this.view.getUint32(4, true);
    this.base = INDEX_HEADER + Math.ceil(this.count / RESTART) * ADDRESS;
    this.sourceBytes = this.view.getFloat64(48, true);
    if (
      !this.count ||
      bytes.length !== this.base + this.count * RECORD ||
      !Number.isSafeInteger(this.sourceBytes) ||
      this.sourceBytes < HEADER
    )
      throw Error("Truncated numeric directory");
  }
  lookup(ordinal: number, length: number) {
    if (
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= this.count ||
      length < 2 ||
      length > 5
    )
      return;
    const first = Math.floor(ordinal / RESTART) * RESTART,
      p = INDEX_HEADER + Math.floor(ordinal / RESTART) * ADDRESS,
      column = length - 2;
    let offset = this.view.getFloat64(p, true),
      scoreOffset = this.view.getFloat64(p + 8 + column * 8, true);
    for (let i = first; i < ordinal; i++) {
      offset += this.view.getUint32(this.base + i * RECORD, true);
      scoreOffset += this.view.getUint16(
        this.base + i * RECORD + 4 + column * 2,
        true,
      );
    }
    const bytes = this.view.getUint32(this.base + ordinal * RECORD, true),
      scoreBytes = this.view.getUint16(
        this.base + ordinal * RECORD + 4 + column * 2,
        true,
      );
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + bytes > this.sourceBytes ||
      bytes < HEADER ||
      !Number.isSafeInteger(scoreOffset) ||
      scoreOffset < 0 ||
      !scoreBytes
    )
      throw Error("Invalid numeric directory range");
    return {
      base: { offset, length: bytes },
      score: { offset: scoreOffset, length: scoreBytes },
    };
  }
  /** Every base packet has one header and the same three column frames.
   * Subtract cumulative headers/documents/positions to recover the original
   * flag address. No additional bundled address or remote discovery is needed. */
  flags(block: SuffixBlock) {
    const ref = this.lookup(block.ordinal!, 2);
    if (!ref) throw Error("Missing numeric block ordinal");
    const offset =
        ref.base.offset -
        HEADER * block.ordinal! -
        block.columns.documents.offset -
        block.columns.positions.offset,
      length =
        ref.base.length -
        HEADER -
        block.columns.documents.length -
        block.columns.positions.length;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1
    )
      throw Error("Invalid numeric flag address");
    return { offset, length };
  }
}
