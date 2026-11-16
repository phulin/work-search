import { contribution } from "../columnar/scoring.js";
import type { NumericDocument } from "../columnar/construction/analyzed-document.js";

export const SUFFIX_ROW_BYTES = 48;
export const PREFIX_WORDS = 8;
export const SUFFIX_BLOCK_ROWS = 4096;
export interface FixedScores {
  count: number;
  avgBody: number;
  avgTitle: number;
  titleBoost: number;
  df: Uint32Array;
  idf?: Float64Array;
}
export interface Quantizer {
  maximum: number;
  bits: 8 | 16;
  step: number;
}
export function quantizer(count: number, bits: 8 | 16): Quantizer {
  // At most five distinct words. tf/(tf+positive) < 1 in both fields.
  const maximum = 5 * 2.2 * 3 * Math.log(1 + (count - 0.5) / 1.5);
  return quantizerForMaximum(maximum, bits);
}
export function quantizerForMaximum(maximum: number, bits: 8 | 16): Quantizer {
  if (!Number.isFinite(maximum) || maximum < 0)
    throw Error("Invalid suffix score maximum");
  return { maximum, bits, step: (maximum || Number.EPSILON) / (2 ** bits - 1) };
}
export function quantize(score: number, q: Quantizer) {
  const error = 128 * Number.EPSILON * Math.max(1, q.maximum);
  if (!Number.isFinite(score) || score < 0 || score > q.maximum + error)
    throw Error("Suffix score outside fixed bounds");
  return Math.min(2 ** q.bits - 1, Math.floor(score / q.step));
}
export function scoreInterval(code: number, q: Quantizer) {
  if (!Number.isInteger(code) || code < 0 || code >= 2 ** q.bits)
    throw Error("Invalid quantized score");
  const error = 128 * Number.EPSILON * Math.max(1, q.maximum);
  return {
    lower: Math.max(0, code * q.step - error),
    upper: Math.min(q.maximum, (code + 1) * q.step) + error,
  };
}
/** Field sentinels are zero. Token identities must be positive. Equal complete
 * suffixes are ordered by physical offset; score ties still use document IDs. */
export function compareSuffix(tokens: Uint32Array, a: number, b: number) {
  const aa = a,
    bb = b;
  if (a === b) return 0;
  for (;;) {
    if (a >= tokens.length || b >= tokens.length)
      throw Error("Unterminated suffix");
    const x = tokens[a++],
      y = tokens[b++];
    if (x !== y) return x - y;
    if (!x) return aa - bb;
  }
}
export function prefix(
  tokens: Uint32Array,
  offset: number,
  length = PREFIX_WORDS,
) {
  const words = new Uint32Array(length);
  for (let i = 0; i < length && tokens[offset + i]; i++)
    words[i] = tokens[offset + i];
  return words;
}
export function comparePrefix(a: ArrayLike<number>, b: ArrayLike<number>) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    if (x !== y) return x - y;
    if (!x) return 0;
  }
  return 0;
}
export function canonicalBit(length: number, field: "all" | "body" | "title") {
  if (length < 2 || length > 5)
    throw Error("Canonical prefixes cover lengths 2–5");
  return 1 << ((length - 2) * 3 + { all: 0, body: 1, title: 2 }[field]);
}
/** Source-ordered rows carry their scores through external suffix sorting.
 * No random per-position disk read is needed to recover scoring inputs. */
export function documentSuffixRows(
  row: NumericDocument,
  start: number,
  stats: FixedScores,
) {
  if (stats.titleBoost !== 2)
    throw Error("Suffix scores use fixed title boost 2");
  const fields = [row.body, row.title],
    frequency = new Map<number, [number, number]>(),
    scores = new Map<number, number>();
  for (let f = 0; f < 2; f++)
    for (const id of fields[f]) {
      if (!id || id >= stats.df.length || !stats.df[id])
        throw Error("Unknown suffix token");
      let n = frequency.get(id);
      if (!n) frequency.set(id, (n = [0, 0]));
      n[f]++;
    }
  for (const [id, n] of frequency) {
    const idf =
      stats.idf?.[id] ??
      Math.log(1 + (stats.count - stats.df[id] + 0.5) / (stats.df[id] + 0.5));
    scores.set(
      id,
      contribution(n[0], row.body.length, stats.avgBody || 1, idf) +
        stats.titleBoost *
          contribution(n[1], row.title.length, stats.avgTitle || 1, idf),
    );
  }
  const bytes = new Uint8Array(
      (row.body.length + row.title.length) * SUFFIX_ROW_BYTES,
    ),
    v = new DataView(bytes.buffer),
    seen = Array.from(
      { length: 4 },
      () => new Map<number, number | number[]>(),
    ),
    titleSeen = Array.from(
      { length: 4 },
      () => new Map<number, number | number[]>(),
    );
  const equal = (other: number, p: number, length: number, field: number) => {
    const source = fields[other >= 2 ** 31 ? 1 : 0],
      at = other % 2 ** 31;
    for (let i = 0; i < length; i++)
      if (source[at + i] !== fields[field][p + i]) return false;
    return true;
  };
  const previousOccurrence = (
    map: Map<number, number | number[]>,
    hash: number,
    p: number,
    length: number,
    field: number,
  ) => {
    const value = map.get(hash),
      encoded = p + field * 2 ** 31;
    if (value === undefined) {
      map.set(hash, encoded);
      return false;
    }
    if (typeof value === "number") {
      if (equal(value, p, length, field)) return true;
      map.set(hash, [value, encoded]);
      return false;
    }
    for (const other of value) if (equal(other, p, length, field)) return true;
    value.push(encoded);
    return false;
  };
  let at = 0,
    global = start;
  for (let f = 0; f < 2; f++) {
    const tokens = fields[f];
    if (tokens.length >= 2 ** 31 || global + tokens.length >= 2 ** 32)
      throw Error("Suffix experiment exceeds 32-bit positions");
    for (let p = 0; p < tokens.length; p++, at += SUFFIX_ROW_BYTES) {
      v.setUint32(at, global + p, true);
      v.setUint32(at + 4, row.doc, true);
      v.setUint32(at + 8, p + f * 2 ** 31, true);
      let score = 0,
        flags = 0,
        hash = 2166136261;
      for (let n = 1; n <= 5 && p + n <= tokens.length; n++) {
        const id = tokens[p + n - 1];
        hash = Math.imul(hash ^ id, 16777619) >>> 0;
        let repeated = false;
        for (let j = 0; j < n - 1; j++)
          if (tokens[p + j] === id) {
            repeated = true;
            break;
          }
        if (!repeated) score += scores.get(id)!;
        if (n < 2) continue;
        if (!previousOccurrence(seen[n - 2], hash, p, n, f))
          flags |= canonicalBit(n, "all") | (!f ? canonicalBit(n, "body") : 0);
        if (f && !previousOccurrence(titleSeen[n - 2], hash, p, n, f))
          flags |= canonicalBit(n, "title");
        // Keep full precision through sorting. Each aligned block selects its
        // own scale after canonical occurrences have been grouped by suffix.
        v.setFloat64(at + 16 + (n - 2) * 8, score, true);
      }
      v.setUint16(at + 12, flags, true);
    }
    global += tokens.length + 1;
  }
  return bytes;
}
export type SuffixColumn =
  | "documents"
  | "positions"
  | "offsets"
  | "flags"
  | "keys"
  | `score16-${number}`
  | `score8-${number}`;
export interface SuffixRef {
  offset: number;
  length: number;
}
export interface SuffixBlock {
  /** Physical ordinal from the bundled block directory, when available. */
  ordinal?: number;
  first: number;
  count: number;
  low: number[];
  high: number[];
  columns: Record<SuffixColumn, SuffixRef>;
  /** All-field upper bounds; conservative for body/title at the fixed boost. */
  scoreMaximum: number[];
  minDocument: number;
}
export interface SuffixManifest {
  format: "word-suffix-1";
  generation: string;
  corpusGeneration: string;
  count: number;
  rows: number;
  analysis?: string;
  fixed: { titleBoost: 2; avgBody: number; avgTitle: number };
  directory: {
    low: number[];
    high: number[];
    first: number;
    end: number;
    ref: SuffixRef;
    scoreMaximum?: number[];
    minDocument?: number;
    ranking?: Partial<Record<number, SuffixRef>>;
  }[];
  files: Record<string, { bytes: number; sha256: string }>;
  phraseRanks?: string;
  phraseRankIndex?: string;
  phraseRankRows?: string;
  fences?: string;
  numericPackets?: { index: string; data: string };
}
