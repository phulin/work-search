import { comparePhrase } from "./keys.js";
import type { SuffixBlock, SuffixManifest, SuffixColumn } from "./format.js";

const MAGIC = 0x31465357,
  HEADER = 48,
  RECORD = 47,
  WORDS = 5;
const generationBytes = (generation: string) => {
  if (!/^[0-9a-f]{64}$/.test(generation))
    throw Error("Invalid suffix corpus identity");
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(generation.slice(i * 2, i * 2 + 2), 16),
  );
};

/** Fixed binary block fences stay directly readable in the bundle. The five
 * prefix IDs use 24 bits each; offsets remain float64 for files above 4 GiB. */
export function suffixFenceHeader(count: number, corpus: string, rows: number) {
  const raw = new Uint8Array(HEADER),
    v = new DataView(raw.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, count, true);
  v.setUint32(8, rows, true);
  raw.set(generationBytes(corpus), 16);
  return raw;
}
export function encodeSuffixFenceRecords(blocks: SuffixBlock[]) {
  const raw = new Uint8Array(RECORD * blocks.length),
    v = new DataView(raw.buffer);
  let expected = blocks[0]?.first ?? 0,
    previous: number[] = [];
  blocks.forEach((b, i) => {
    if (
      b.first !== expected ||
      !b.count ||
      b.count > 65535 ||
      (i && comparePhrase(previous, b.low.slice(0, WORDS)) > 0)
    )
      throw Error("Invalid suffix fence coverage");
    const at = i * RECORD;
    v.setUint32(at, b.first, true);
    v.setUint16(at + 4, b.count, true);
    for (let w = 0; w < WORDS; w++) {
      const n = b.low[w] ?? 0;
      if (!Number.isInteger(n) || n < 0 || n > 0xffffff)
        throw Error("Suffix fence token exceeds 24 bits");
      v.setUint16(at + 6 + w * 3, n & 65535, true);
      v.setUint8(at + 8 + w * 3, n >>> 16);
    }
    const ref = b.columns.keys;
    if (
      !ref ||
      !Number.isSafeInteger(ref.offset) ||
      ref.offset < 0 ||
      !Number.isInteger(ref.length) ||
      ref.length < 1 ||
      ref.length > 0xffffffff
    )
      throw Error("Invalid suffix fence key reference");
    v.setFloat64(at + 21, ref.offset, true);
    v.setUint32(at + 29, ref.length, true);
    for (const [j, name] of ["documents", "positions"].entries()) {
      const r = b.columns[name as SuffixColumn];
      if (
        !r ||
        !Number.isSafeInteger(r.offset) ||
        r.offset < 0 ||
        r.offset >= 2 ** 40 ||
        !Number.isInteger(r.length) ||
        r.length < 1 ||
        r.length > 65535
      )
        throw Error("Invalid suffix fence numeric reference");
      v.setUint32(at + 33 + j * 7, r.offset >>> 0, true);
      v.setUint8(at + 37 + j * 7, Math.floor(r.offset / 2 ** 32));
      v.setUint16(at + 38 + j * 7, r.length, true);
    }
    previous = b.low;
    expected += b.count;
  });
  return raw;
}
export function encodeSuffixFences(
  blocks: SuffixBlock[],
  corpus: string,
  rows: number,
) {
  if (
    blocks[0]?.first !== 0 ||
    blocks.at(-1)!.first + blocks.at(-1)!.count !== rows
  )
    throw Error("Suffix fence row count differs");
  const records = encodeSuffixFenceRecords(blocks),
    raw = new Uint8Array(HEADER + records.length);
  raw.set(suffixFenceHeader(blocks.length, corpus, rows));
  raw.set(records, HEADER);
  return raw;
}

export class SuffixFences {
  private view: DataView;
  readonly count: number;
  constructor(
    readonly bytes: Uint8Array,
    manifest: Pick<SuffixManifest, "corpusGeneration" | "rows">,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < HEADER ||
      this.view.getUint32(0, true) !== MAGIC ||
      this.view.getUint32(8, true) !== manifest.rows ||
      generationBytes(manifest.corpusGeneration).some(
        (b, i) => b !== bytes[16 + i],
      )
    )
      throw Error("Invalid suffix fences");
    this.count = this.view.getUint32(4, true);
    if (!this.count || bytes.length !== HEADER + RECORD * this.count)
      throw Error("Truncated suffix fences");
  }
  private compare(i: number, phrase: Uint32Array) {
    const at = HEADER + i * RECORD;
    for (let w = 0; w < phrase.length; w++) {
      const n =
        this.view.getUint16(at + 6 + w * 3, true) +
        this.view.getUint8(at + 8 + w * 3) * 65536;
      if (!n) return -1;
      if (n !== phrase[w]) return n - phrase[w];
    }
    return 0;
  }
  private block(i: number): SuffixBlock {
    const at = HEADER + i * RECORD,
      low = Array.from(
        { length: WORDS },
        (_, w) =>
          this.view.getUint16(at + 6 + w * 3, true) +
          this.view.getUint8(at + 8 + w * 3) * 65536,
      ),
      offset = this.view.getFloat64(at + 21, true),
      length = this.view.getUint32(at + 29, true),
      first = this.view.getUint32(at, true),
      count = this.view.getUint16(at + 4, true);
    if (
      !count ||
      first + count > this.view.getUint32(8, true) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !length
    )
      throw Error("Invalid suffix fence record");
    const columns = { keys: { offset, length } } as SuffixBlock["columns"];
    for (const [j, name] of ["documents", "positions"].entries())
      columns[name as SuffixColumn] = {
        offset:
          this.view.getUint32(at + 33 + j * 7, true) +
          this.view.getUint8(at + 37 + j * 7) * 2 ** 32,
        length: this.view.getUint16(at + 38 + j * 7, true),
      };
    return {
      first,
      count,
      low,
      high: [],
      columns,
      scoreMaximum: [],
      minDocument: 0,
    };
  }
  blocks(first: number, end: number) {
    let lo = 0,
      hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1,
        at = HEADER + mid * RECORD;
      if (
        this.view.getUint32(at, true) + this.view.getUint16(at + 4, true) <=
        first
      )
        lo = mid + 1;
      else hi = mid;
    }
    const blocks: SuffixBlock[] = [];
    for (let i = lo; i < this.count; i++) {
      const block = this.block(i);
      if (block.first >= end) break;
      blocks.push(block);
    }
    return blocks;
  }
  /** A phrase may begin in the preceding block even when the next block's
   * first suffix equals it. Resolve the two conservative edge blocks exactly. */
  bounds(phrase: Uint32Array) {
    if (!phrase.length || phrase.length > WORDS || phrase.some((x) => !x))
      return;
    const locate = (upper: boolean) => {
      let lo = 0,
        hi = this.count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1,
          cmp = this.compare(mid, phrase);
        if (cmp < 0 || (upper && cmp === 0)) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    };
    return [this.block(locate(false)), this.block(locate(true))] as const;
  }
}
