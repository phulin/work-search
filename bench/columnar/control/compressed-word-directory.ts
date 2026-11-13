// Frozen compressed-vocabulary benchmark control.
import { concat, u32, view } from "../../../src/columnar/format.js";
import {
  assembleTermDirectory,
  type DirectoryBlock,
} from "../../../src/columnar/term-directory.js";
import { Lru } from "../../../src/columnar/storage.js";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true }),
  MAGIC = 0x31495743;
function integer(out: number[], n: number) {
  do {
    const b = n % 128;
    n = Math.floor(n / 128);
    out.push(b | (n ? 128 : 0));
  } while (n);
}
function take(data: Uint8Array, c: { at: number }) {
  let n = 0,
    scale = 1;
  for (let i = 0; i < 5; i++) {
    if (c.at >= data.length) throw Error("Truncated word directory");
    const b = data[c.at++];
    n += (b & 127) * scale;
    if (!(b & 128)) return n;
    scale *= 128;
  }
  throw Error("Invalid word directory integer");
}
/** A constructor-only vocabulary: exact normalized words map to their lexical
 * ordinal IDs. It carries no posting metadata or serving compatibility layer. */
export function encodeWords(words: string[]) {
  if (!words.length || words.length > 4096)
    throw Error("Invalid word block count");
  const parts = [u32([words.length])];
  let previous = new Uint8Array();
  words.forEach((word, i) => {
    if (i && words[i - 1] >= word) throw Error("Unsorted words");
    const bytes = encoder.encode(word),
      header: number[] = [];
    let prefix = 0;
    while (
      prefix < bytes.length &&
      prefix < previous.length &&
      bytes[prefix] === previous[prefix]
    )
      prefix++;
    integer(header, prefix);
    integer(header, bytes.length - prefix);
    parts.push(Uint8Array.from(header), bytes.subarray(prefix));
    previous = bytes;
  });
  return concat(parts);
}
export function decodeWords(raw: Uint8Array) {
  if (raw.length < 4) throw Error("Truncated word block");
  const count = view(raw).getUint32(0, true),
    c = { at: 4 },
    words: string[] = [];
  if (!count || count > 4096) throw Error("Invalid word block count");
  let previous = new Uint8Array();
  for (let i = 0; i < count; i++) {
    const prefix = take(raw, c),
      suffix = take(raw, c);
    if (prefix > previous.length || c.at + suffix > raw.length)
      throw Error("Invalid word span");
    const bytes = new Uint8Array(prefix + suffix);
    bytes.set(previous.subarray(0, prefix));
    bytes.set(raw.subarray(c.at, c.at + suffix), prefix);
    c.at += suffix;
    const word = decoder.decode(bytes);
    if (i && words[i - 1] >= word) throw Error("Unsorted word block");
    words.push(word);
    previous = bytes;
  }
  if (c.at !== raw.length) throw Error("Trailing word bytes");
  return words;
}
export function assembleWords(blocks: DirectoryBlock[]) {
  const bytes = assembleTermDirectory(blocks);
  view(bytes).setUint32(0, MAGIC, true);
  return bytes;
}
export class WordDirectory {
  private v: DataView;
  private keys: string[] = [];
  private cache = new Lru<string[]>(2 * 1048576);
  readonly count: number;
  constructor(readonly bytes: Uint8Array) {
    this.v = view(bytes);
    if (bytes.length < 16 || this.v.getUint32(0, true) !== MAGIC)
      throw Error("Invalid word directory");
    this.count = this.v.getUint32(4, true);
    const n = this.v.getUint32(8, true),
      start = this.v.getUint32(12, true);
    if (16 + n * 20 > start || start > bytes.length)
      throw Error("Invalid word directory header");
    let previousKey = 16 + n * 20,
      previousData = start,
      previousOrdinal = -1;
    for (let i = 0; i < n; i++) {
      const p = 16 + i * 20,
        k = this.v.getUint32(p, true),
        kl = this.v.getUint32(p + 4, true),
        at = this.v.getUint32(p + 8, true),
        size = this.v.getUint32(p + 12, true),
        ordinal = this.v.getUint32(p + 16, true);
      if (
        k !== previousKey ||
        k + kl > start ||
        at !== previousData ||
        !size ||
        at + size > bytes.length ||
        ordinal <= previousOrdinal ||
        ordinal >= this.count ||
        (i === 0 && ordinal !== 0)
      )
        throw Error("Invalid word directory range");
      const key = decoder.decode(bytes.subarray(k, k + kl));
      if (i && this.keys[i - 1] >= key) throw Error("Unsorted word directory");
      this.keys.push(key);
      previousKey = k + kl;
      previousData = at + size;
      previousOrdinal = ordinal;
    }
    if (
      previousKey !== start ||
      previousData !== bytes.length ||
      (!n && this.count)
    )
      throw Error("Incomplete word directory");
  }
  async lookup(names: string[]) {
    const wanted = new Map<number, string[]>(),
      found = new Map<string, number>();
    for (const name of names) {
      let lo = 0,
        hi = this.keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.keys[mid] <= name) lo = mid + 1;
        else hi = mid;
      }
      if (lo) {
        const group = wanted.get(lo - 1) ?? [];
        group.push(name);
        wanted.set(lo - 1, group);
      }
    }
    const jobs = [...wanted];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, jobs.length) }, async () => {
        for (;;) {
          const j = next++;
          if (j >= jobs.length) return;
          const [i, names] = jobs[j],
            key = String(i),
            p = 16 + i * 20,
            ordinal = this.v.getUint32(p + 16, true);
          let words = this.cache.get(key);
          if (!words) {
            const at = this.v.getUint32(p + 8, true),
              n = this.v.getUint32(p + 12, true),
              raw = new Uint8Array(
                await new Response(
                  new Response(
                    this.bytes.subarray(at, at + n) as BodyInit,
                  ).body!.pipeThrough(new DecompressionStream("gzip")),
                ).arrayBuffer(),
              );
            words = decodeWords(raw);
            const expected =
              (i + 1 < this.keys.length
                ? this.v.getUint32(p + 36, true)
                : this.count) - ordinal;
            if (words.length !== expected || words[0] !== this.keys[i])
              throw Error("Word block identity mismatch");
            this.cache.set(
              key,
              words,
              words.reduce((n, word) => n + 48 + word.length * 2, 0),
            );
          }
          for (const name of names) {
            let lo = 0,
              hi = words.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (words[mid] < name) lo = mid + 1;
              else hi = mid;
            }
            if (words[lo] === name) found.set(name, ordinal + lo + 1);
          }
        }
      }),
    );
    return found;
  }
}
