import { comparePrefix } from "./format.js";

const MAGIC = 0x31505357,
  HEADER = 48,
  RECORD = 32,
  ENTRY = 24;
export interface PhraseRankEntry {
  doc: number;
  position: number;
  lower: number;
  upper: number;
}
export interface PhraseRankRecord {
  words: number[];
  entries: PhraseRankEntry[];
  tailUpper: number;
}
const identity = (generation: string) => {
  if (!/^[a-f0-9]{64}$/.test(generation))
    throw Error("Invalid suffix phrase ranking identity");
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(generation.slice(i * 2, i * 2 + 2), 16),
  );
};
export function encodePhraseRanks(
  records: PhraseRankRecord[],
  corpus: string,
  rows: number,
) {
  const sorted = records
      .slice()
      .sort((a, b) => comparePrefix(a.words, b.words)),
    raw = new Uint8Array(
      HEADER +
        sorted.length * RECORD +
        sorted.reduce((n, r) => n + r.entries.length * ENTRY, 0),
    ),
    v = new DataView(raw.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, sorted.length, true);
  v.setUint32(8, rows, true);
  raw.set(identity(corpus), 16);
  let offset = HEADER + sorted.length * RECORD;
  sorted.forEach((r, i) => {
    if (
      r.words.length < 2 ||
      r.words.length > 5 ||
      r.words.some((w) => !Number.isInteger(w) || w < 1 || w > 0xffffff) ||
      !r.entries.length ||
      r.entries.length > 255 ||
      !Number.isFinite(r.tailUpper) ||
      r.tailUpper < 0 ||
      (i && comparePrefix(sorted[i - 1].words, r.words) === 0)
    )
      throw Error("Invalid suffix phrase ranking");
    const at = HEADER + i * RECORD;
    v.setUint8(at, r.words.length);
    r.words.forEach((w, j) => {
      v.setUint16(at + 1 + j * 3, w & 65535, true);
      v.setUint8(at + 3 + j * 3, w >>> 16);
    });
    v.setUint32(at + 16, offset, true);
    v.setUint16(at + 20, r.entries.length, true);
    v.setFloat64(at + 24, r.tailUpper, true);
    const seen = new Set<number>();
    for (const entry of r.entries) {
      if (
        !Number.isInteger(entry.doc) ||
        entry.doc < 0 ||
        entry.doc > 0xffffffff ||
        !Number.isInteger(entry.position) ||
        entry.position < 0 ||
        entry.position > 0xffffffff ||
        !Number.isFinite(entry.lower) ||
        !Number.isFinite(entry.upper) ||
        entry.lower < 0 ||
        entry.upper < entry.lower ||
        seen.has(entry.doc)
      )
        throw Error("Invalid suffix phrase ranking entry");
      seen.add(entry.doc);
      v.setUint32(offset, entry.doc, true);
      v.setUint32(offset + 4, entry.position, true);
      v.setFloat64(offset + 8, entry.lower, true);
      v.setFloat64(offset + 16, entry.upper, true);
      offset += ENTRY;
    }
  });
  return raw;
}

/** Bundled canonical rows with conservative bounds for every omitted row.
 * These are ranking proofs, never an incomplete phrase membership list. */
export class PhraseRanks {
  private view: DataView;
  readonly count: number;
  constructor(
    readonly bytes: Uint8Array,
    corpus: string,
    rows: number,
    readonly documents: number,
    readonly sourceBytes = bytes.length,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < HEADER ||
      this.view.getUint32(0, true) !== MAGIC ||
      this.view.getUint32(8, true) !== rows ||
      identity(corpus).some((b, i) => b !== bytes[16 + i])
    )
      throw Error("Invalid suffix phrase rankings");
    this.count = this.view.getUint32(4, true);
    if (HEADER + this.count * RECORD > bytes.length)
      throw Error("Truncated suffix phrase rankings");
  }
  locate(words: Uint32Array) {
    if (words.length < 2 || words.length > 5) return;
    const compare = (i: number) => {
      const at = HEADER + i * RECORD,
        length = this.view.getUint8(at);
      for (let j = 0; j < Math.min(length, words.length); j++) {
        const word =
          this.view.getUint16(at + 1 + j * 3, true) +
          this.view.getUint8(at + 3 + j * 3) * 65536;
        if (word !== words[j]) return word - words[j];
      }
      return length - words.length;
    };
    let lo = 0,
      hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(mid) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.count || compare(lo)) return;
    const at = HEADER + lo * RECORD,
      offset = this.view.getUint32(at + 16, true),
      count = this.view.getUint16(at + 20, true),
      tailUpper = this.view.getFloat64(at + 24, true),
      length = count * ENTRY;
    if (
      !count ||
      count > 255 ||
      offset < HEADER + this.count * RECORD ||
      offset + length > this.sourceBytes ||
      !Number.isFinite(tailUpper) ||
      tailUpper < 0
    )
      throw Error("Invalid suffix phrase ranking range");
    return { offset, length, count, tailUpper };
  }
  decode(raw: Uint8Array) {
    if (!raw.length || raw.length % ENTRY || raw.length > 255 * ENTRY)
      throw Error("Invalid suffix phrase ranking payload");
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
      entries: PhraseRankEntry[] = [];
    const seen = new Set<number>();
    for (let p = 0; p < raw.length; p += ENTRY) {
      const doc = view.getUint32(p, true),
        position = view.getUint32(p + 4, true),
        lower = view.getFloat64(p + 8, true),
        upper = view.getFloat64(p + 16, true);
      if (
        doc >= this.documents ||
        !Number.isFinite(lower) ||
        !Number.isFinite(upper) ||
        lower < 0 ||
        upper < lower ||
        seen.has(doc)
      )
        throw Error("Invalid suffix phrase ranking entry");
      seen.add(doc);
      entries.push({ doc, position, lower, upper });
    }
    return entries;
  }
  lookup(words: Uint32Array) {
    const ref = this.locate(words);
    if (!ref) return;
    if (ref.offset + ref.length > this.bytes.length)
      throw Error("Phrase ranking payload is external");
    return {
      entries: this.decode(
        this.bytes.subarray(ref.offset, ref.offset + ref.length),
      ),
      tailUpper: ref.tailUpper,
    };
  }
}

/** The complete directory is small enough to route one payload read locally. */
export function phraseRankDirectory(raw: Uint8Array) {
  if (raw.length < HEADER) throw Error("Truncated suffix phrase rankings");
  const size =
    HEADER +
    new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(
      4,
      true,
    ) *
      RECORD;
  if (size > raw.length) throw Error("Truncated suffix phrase rankings");
  return raw.slice(0, size);
}
