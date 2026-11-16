import { comparePhrase } from "./keys.js";
import type { SuffixBlock, SuffixManifest, SuffixColumn } from "./format.js";
const MAGIC = 0x32465357,
  HEADER = 48,
  RECORD = 25,
  RESTART = 64,
  ADDRESS = 28,
  WORDS = 5;
const identity = (generation: string) => {
  if (!/^[a-f0-9]{64}$/.test(generation))
    throw Error("Invalid suffix corpus identity");
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(generation.slice(i * 2, i * 2 + 2), 16),
  );
};
/** Restart addresses replace repeated absolute offsets. Every aligned column
 * remains directly reachable after at most 63 additions, with no remote read. */
export class SuffixFenceBuilder {
  readonly bytes: Uint8Array;
  private view: DataView;
  private base: number;
  private at = 0;
  private expected = 0;
  private offsets = [0, 0, 0];
  private previous: number[] = [];
  constructor(
    readonly count: number,
    corpus: string,
    readonly rows: number,
  ) {
    if (!Number.isInteger(count) || count < 1)
      throw Error("Invalid suffix fence count");
    this.base = HEADER + Math.ceil(count / RESTART) * ADDRESS;
    this.bytes = new Uint8Array(this.base + count * RECORD);
    this.view = new DataView(this.bytes.buffer);
    this.view.setUint32(0, MAGIC, true);
    this.view.setUint32(4, count, true);
    this.view.setUint32(8, rows, true);
    this.bytes.set(identity(corpus), 16);
  }
  append(blocks: SuffixBlock[]) {
    for (const b of blocks) {
      if (
        this.at >= this.count ||
        b.first !== this.expected ||
        !b.count ||
        b.count > 65535 ||
        (this.at && comparePhrase(this.previous, b.low.slice(0, WORDS)) > 0)
      )
        throw Error("Invalid suffix fence coverage");
      const refs = ["keys", "documents", "positions"].map(
          (n) => b.columns[n as SuffixColumn],
        ),
        restart = this.at % RESTART === 0,
        at = this.base + this.at * RECORD;
      refs.forEach((r, j) => {
        if (
          !r ||
          !Number.isSafeInteger(r.offset) ||
          r.offset < 0 ||
          !Number.isInteger(r.length) ||
          r.length < 1 ||
          r.length > (j ? 65535 : 0xffffffff)
        )
          throw Error("Invalid suffix fence reference");
        if (!restart && r.offset !== this.offsets[j])
          throw Error("Noncontiguous suffix column");
      });
      if (restart) {
        const p = HEADER + Math.floor(this.at / RESTART) * ADDRESS;
        this.view.setUint32(p, b.first, true);
        refs.forEach((r, j) =>
          this.view.setFloat64(p + 4 + j * 8, r.offset, true),
        );
      }
      this.view.setUint16(at, b.count, true);
      for (let w = 0; w < WORDS; w++) {
        const n = b.low[w] ?? 0;
        if (!Number.isInteger(n) || n < 0 || n > 0xffffff)
          throw Error("Suffix fence token exceeds 24 bits");
        this.view.setUint16(at + 2 + w * 3, n & 65535, true);
        this.view.setUint8(at + 4 + w * 3, n >>> 16);
      }
      this.view.setUint32(at + 17, refs[0].length, true);
      this.view.setUint16(at + 21, refs[1].length, true);
      this.view.setUint16(at + 23, refs[2].length, true);
      this.offsets = refs.map((r) => r.offset + r.length);
      this.expected += b.count;
      this.previous = b.low;
      this.at++;
    }
  }
  finish() {
    if (this.at !== this.count || this.expected !== this.rows)
      throw Error("Suffix fence row count differs");
    return this.bytes;
  }
}
export function encodeSuffixFences(
  blocks: SuffixBlock[],
  corpus: string,
  rows: number,
) {
  const builder = new SuffixFenceBuilder(blocks.length, corpus, rows);
  builder.append(blocks);
  return builder.finish();
}
export class SuffixFences {
  private view: DataView;
  readonly count: number;
  private base: number;
  constructor(
    readonly bytes: Uint8Array,
    manifest: Pick<SuffixManifest, "corpusGeneration" | "rows">,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < HEADER ||
      this.view.getUint32(0, true) !== MAGIC ||
      this.view.getUint32(8, true) !== manifest.rows ||
      identity(manifest.corpusGeneration).some((b, i) => b !== bytes[16 + i])
    )
      throw Error("Invalid suffix fences");
    this.count = this.view.getUint32(4, true);
    this.base = HEADER + Math.ceil(this.count / RESTART) * ADDRESS;
    if (!this.count || bytes.length !== this.base + this.count * RECORD)
      throw Error("Truncated suffix fences");
  }
  private compare(i: number, phrase: Uint32Array) {
    const at = this.base + i * RECORD;
    for (let w = 0; w < phrase.length; w++) {
      const n =
        this.view.getUint16(at + 2 + w * 3, true) +
        this.view.getUint8(at + 4 + w * 3) * 65536;
      if (!n) return -1;
      if (n !== phrase[w]) return n - phrase[w];
    }
    return 0;
  }
  private address(i: number) {
    const start = Math.floor(i / RESTART) * RESTART,
      p = HEADER + Math.floor(i / RESTART) * ADDRESS,
      offsets = Array.from({ length: 3 }, (_, j) =>
        this.view.getFloat64(p + 4 + j * 8, true),
      );
    let first = this.view.getUint32(p, true);
    for (let j = start; j < i; j++) {
      const at = this.base + j * RECORD;
      first += this.view.getUint16(at, true);
      offsets[0] += this.view.getUint32(at + 17, true);
      offsets[1] += this.view.getUint16(at + 21, true);
      offsets[2] += this.view.getUint16(at + 23, true);
    }
    return { first, offsets };
  }
  private block(i: number): SuffixBlock {
    const at = this.base + i * RECORD,
      { first, offsets } = this.address(i),
      count = this.view.getUint16(at, true),
      low = Array.from(
        { length: WORDS },
        (_, w) =>
          this.view.getUint16(at + 2 + w * 3, true) +
          this.view.getUint8(at + 4 + w * 3) * 65536,
      ),
      columns = {} as SuffixBlock["columns"];
    ["keys", "documents", "positions"].forEach((n, j) => {
      const length = j
        ? this.view.getUint16(at + 19 + j * 2, true)
        : this.view.getUint32(at + 17, true);
      if (!Number.isSafeInteger(offsets[j]) || offsets[j] < 0 || !length)
        throw Error("Invalid suffix fence record");
      columns[n as SuffixColumn] = { offset: offsets[j], length };
    });
    return {
      ordinal: i,
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
      const m = (lo + hi) >>> 1,
        address = this.address(m);
      if (
        address.first + this.view.getUint16(this.base + m * RECORD, true) <=
        first
      )
        lo = m + 1;
      else hi = m;
    }
    const blocks: SuffixBlock[] = [];
    for (let i = lo; i < this.count; i++) {
      const b = this.block(i);
      if (b.first >= end) break;
      blocks.push(b);
    }
    return blocks;
  }
  bounds(phrase: Uint32Array) {
    if (!phrase.length || phrase.length > WORDS || phrase.some((x) => !x))
      return;
    const locate = (upper: boolean) => {
      let lo = 0,
        hi = this.count;
      while (lo < hi) {
        const m = (lo + hi) >>> 1,
          cmp = this.compare(m, phrase);
        if (cmp < 0 || (upper && cmp === 0)) lo = m + 1;
        else hi = m;
      }
      return Math.max(0, lo - 1);
    };
    return [this.block(locate(false)), this.block(locate(true))] as const;
  }
}
