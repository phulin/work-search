import { Dictionary, encodeDictionary } from "./format.js";
import { crc32, encoder } from "../format/codec.js";
const WIDTH = 7680,
  ROWS = 4,
  HEADER = 144;
function hash(key: string) {
  return crc32(encoder.encode(key));
}
function slots(fingerprint: number) {
  let h = fingerprint;
  return Array.from({ length: ROWS }, (_, row) => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return row * WIDTH + ((h >>> 0) % WIDTH);
  });
}
export interface PairCostModel {
  upper(key: string): number | undefined;
  df(term: string): number | undefined;
}
/** Corpus-only four-way fingerprint table, preferentially retaining high-DF pairs.
 * Missing fingerprints are unknown, never evidence that a pair is absent.
 * Hash collisions can overestimate cost; this table never prunes documents. */
export class PairCostTable {
  readonly view: DataView;
  readonly dfs: Dictionary;
  constructor(
    readonly bytes: Uint8Array,
    base: string,
    pairs: string,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < HEADER + ROWS * WIDTH * 8 ||
      bytes.length !==
        HEADER + ROWS * WIDTH * 8 + this.view.getUint32(136, true) ||
      this.view.getUint32(0, true) !== 0x33534350 ||
      this.view.getUint32(4, true) !== crc32(bytes.subarray(8)) ||
      new TextDecoder().decode(bytes.subarray(8, 72)) !== base ||
      new TextDecoder().decode(bytes.subarray(72, 136)) !== pairs
    )
      throw Error("Pair cost synopsis generation/checksum mismatch");
    this.dfs = new Dictionary(bytes.subarray(HEADER + ROWS * WIDTH * 8));
  }
  df(term: string) {
    const b = this.dfs.lookup(term);
    return b
      ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true)
      : undefined;
  }
  upper(key: string) {
    const h = hash(key);
    let df: number | undefined;
    for (const i of slots(h)) {
      const at = HEADER + i * 8,
        value = this.view.getUint32(at + 4, true);
      if (value && this.view.getUint32(at, true) === h)
        df = Math.max(df ?? 0, value);
    }
    return df;
  }
}
export class PairCostBuilder {
  readonly bytes = new Uint8Array(HEADER + ROWS * WIDTH * 8);
  private view = new DataView(this.bytes.buffer);
  constructor(base: string, pairs: string) {
    this.view.setUint32(0, 0x33534350, true);
    this.bytes.set(encoder.encode(base), 8);
    this.bytes.set(encoder.encode(pairs), 72);
  }
  add(key: string, df: number) {
    const h = hash(key);
    for (const i of slots(h)) {
      const at = HEADER + i * 8,
        old = this.view.getUint32(at + 4, true);
      if (df > old || (df === old && h < this.view.getUint32(at, true))) {
        this.view.setUint32(at, h, true);
        this.view.setUint32(at + 4, df, true);
      }
    }
  }
  finish(dfs: Iterable<[string, number]> = []) {
    const dictionary = encodeDictionary(
      [...dfs]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([t, n]) => {
          const b = new Uint8Array(4);
          new DataView(b.buffer).setUint32(0, n, true);
          return [t, b] as [string, Uint8Array];
        }),
    );
    const out = new Uint8Array(this.bytes.length + dictionary.length);
    out.set(this.bytes);
    out.set(dictionary, this.bytes.length);
    const v = new DataView(out.buffer);
    v.setUint32(136, dictionary.length, true);
    v.setUint32(4, crc32(out.subarray(8)), true);
    return out;
  }
}
export function encodePairCosts(
  entries: Iterable<[string, number]>,
  base: string,
  pairs: string,
) {
  const b = new PairCostBuilder(base, pairs);
  for (const [k, n] of entries) b.add(k, n);
  return b.finish();
}
