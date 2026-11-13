import { concat, u32, view } from "./format.js";
import {
  assembleTermDirectory,
  type DirectoryBlock,
} from "./term-directory.js";
import { Lru } from "./storage.js";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true }),
  MAGIC = 0x32495743,
  RESTART = 32;
function integer(out: number[], n: number) {
  do {
    const b = n % 128;
    n = Math.floor(n / 128);
    out.push(b | (n ? 128 : 0));
  } while (n);
}
function take(raw: Uint8Array, c: { at: number }, end = raw.length) {
  let n = 0,
    scale = 1;
  for (let i = 0; i < 5; i++) {
    if (c.at >= end) throw Error("Truncated word integer");
    const b = raw[c.at++];
    n += (b & 127) * scale;
    if (!(b & 128)) return n;
    scale *= 128;
  }
  throw Error("Invalid word integer");
}
export function encodeWords(words: string[]) {
  if (!words.length || words.length > 4096) throw Error("Invalid word count");
  const header = u32([
      words.length,
      ...Array(Math.ceil(words.length / RESTART)).fill(0),
    ]),
    v = view(header),
    parts = [header];
  let previous = new Uint8Array(),
    at = header.length;
  words.forEach((word, i) => {
    if (i && words[i - 1] >= word) throw Error("Unsorted words");
    if (i % RESTART === 0) {
      v.setUint32(4 + (i / RESTART) * 4, at, true);
      previous = new Uint8Array();
    }
    const raw = encoder.encode(word),
      prefixOut: number[] = [];
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < raw.length &&
      previous[prefix] === raw[prefix]
    )
      prefix++;
    const suffix = raw.length - prefix;
    prefixOut.push((Math.min(prefix, 15) << 4) | Math.min(suffix, 15));
    if (prefix >= 15) integer(prefixOut, prefix - 15);
    if (suffix >= 15) integer(prefixOut, suffix - 15);
    parts.push(Uint8Array.from(prefixOut), raw.subarray(prefix));
    at += prefixOut.length + suffix;
    previous = raw;
  });
  return concat(parts);
}
function blockHeader(raw: Uint8Array) {
  if (raw.length < 8) throw Error("Truncated word block");
  const v = view(raw),
    count = v.getUint32(0, true),
    groups = Math.ceil(count / RESTART),
    start = 4 + groups * 4;
  if (!count || count > 4096 || start >= raw.length)
    throw Error("Invalid word block");
  let previous = start - 1;
  for (let i = 0; i < groups; i++) {
    const offset = v.getUint32(4 + i * 4, true);
    if (
      (i === 0 && offset !== start) ||
      offset <= previous ||
      offset >= raw.length
    )
      throw Error("Invalid word restart");
    previous = offset;
  }
  return { v, count, groups };
}
function lengths(raw: Uint8Array, c: { at: number }, end: number) {
  if (c.at >= end) throw Error("Truncated word");
  const flags = raw[c.at++];
  let prefix = flags >>> 4,
    suffix = flags & 15;
  if (prefix === 15) prefix += take(raw, c, end);
  if (suffix === 15) suffix += take(raw, c, end);
  return { prefix, suffix };
}
function first(raw: Uint8Array, v: DataView, group: number) {
  const c = { at: v.getUint32(4 + group * 4, true) },
    span = lengths(raw, c, raw.length);
  if (span.prefix || c.at + span.suffix > raw.length)
    throw Error("Invalid restart word");
  return decoder.decode(raw.subarray(c.at, c.at + span.suffix));
}
function decodeGroup(
  raw: Uint8Array,
  v: DataView,
  count: number,
  group: number,
) {
  const groups = Math.ceil(count / RESTART),
    c = { at: v.getUint32(4 + group * 4, true) },
    end = group + 1 < groups ? v.getUint32(8 + group * 4, true) : raw.length,
    words: string[] = [];
  let previous = new Uint8Array();
  for (let i = 0; i < Math.min(RESTART, count - group * RESTART); i++) {
    const { prefix, suffix } = lengths(raw, c, end);
    if (prefix > previous.length || c.at + suffix > end)
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
  if (c.at !== end) throw Error("Trailing word bytes");
  return words;
}
export function decodeWords(raw: Uint8Array) {
  const { v, count, groups } = blockHeader(raw),
    words: string[] = [];
  for (let i = 0; i < groups; i++) {
    const decoded = decodeGroup(raw, v, count, i);
    if (i && words.at(-1)! >= decoded[0]) throw Error("Unsorted word block");
    words.push(...decoded);
  }
  return words;
}
export function assembleWords(blocks: DirectoryBlock[]) {
  const bytes = assembleTermDirectory(blocks);
  view(bytes).setUint32(0, MAGIC, true);
  return bytes;
}
/** Exact constructor vocabulary with directly readable 32-word restarts. No
 * decompression or full-vocabulary materialization is required for lookup. */
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
    for (const [i, names] of wanted) {
      const p = 16 + i * 20,
        at = this.v.getUint32(p + 8, true),
        size = this.v.getUint32(p + 12, true),
        ordinal = this.v.getUint32(p + 16, true),
        raw = this.bytes.subarray(at, at + size),
        { v, count, groups } = blockHeader(raw),
        expected =
          (i + 1 < this.keys.length
            ? this.v.getUint32(p + 36, true)
            : this.count) - ordinal;
      if (count !== expected || first(raw, v, 0) !== this.keys[i])
        throw Error("Word block identity mismatch");
      const requests = new Map<number, string[]>();
      for (const name of names) {
        let lo = 0,
          hi = groups;
        while (lo < hi) {
          const m = (lo + hi) >>> 1;
          if (first(raw, v, m) <= name) lo = m + 1;
          else hi = m;
        }
        if (lo) {
          const ns = requests.get(lo - 1) ?? [];
          ns.push(name);
          requests.set(lo - 1, ns);
        }
      }
      for (const [group, ns] of requests) {
        const key = `${i}:${group}`;
        let words = this.cache.get(key);
        if (!words) {
          words = decodeGroup(raw, v, count, group);
          this.cache.set(
            key,
            words,
            words.reduce((n, w) => n + 48 + w.length * 2, 0),
          );
        }
        for (const name of ns) {
          let lo = 0,
            hi = words.length;
          while (lo < hi) {
            const m = (lo + hi) >>> 1;
            if (words[m] < name) lo = m + 1;
            else hi = m;
          }
          if (words[lo] === name)
            found.set(name, ordinal + group * RESTART + lo + 1);
        }
      }
    }
    return found;
  }
}
