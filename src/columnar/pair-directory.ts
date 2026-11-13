import {
  concat,
  view,
  type PositionalPair,
  type Ref,
  type PairDirectoryShard,
} from "./format.js";
const HEADER = 16,
  ENTRY = 40;
export const comparePair = (a: readonly number[], b: readonly number[]) =>
  a[0] - b[0] || a[1] - b[1];
/** Entries and small complete postings share one immutable lookup range. Inline
 * addresses relocate against that range, so lookup needs no pointer discovery. */
export function encodePairDirectory(
  entries: { pair: PositionalPair; inline?: Uint8Array }[],
) {
  if (!entries.length || entries.length > 4096)
    throw Error("Invalid pair directory count");
  const header = new Uint8Array(HEADER + entries.length * ENTRY),
    v = view(header),
    parts: Uint8Array[] = [header];
  [0x31445043, entries.length, ENTRY, header.length].forEach((n, i) =>
    v.setUint32(i * 4, n, true),
  );
  let offset = header.length;
  entries.forEach(({ pair: p, inline }, i) => {
    if (
      (i &&
        comparePair(
          [entries[i - 1].pair.a, entries[i - 1].pair.b],
          [p.a, p.b],
        ) >= 0) ||
      !Number.isInteger(p.a) ||
      !Number.isInteger(p.b) ||
      p.a < 0 ||
      p.b < 0 ||
      p.a > 0xffffffff ||
      p.b > 0xffffffff ||
      !Number.isInteger(p.df) ||
      p.df < 1 ||
      p.df > 0xffffffff ||
      !Number.isSafeInteger(p.occurrences) ||
      p.occurrences < p.df ||
      (inline && inline.length !== p.ref[2])
    )
      throw Error("Invalid pair directory entry");
    const at = HEADER + i * ENTRY,
      ref: Ref = inline ? [0, offset, inline.length] : p.ref;
    [p.a, p.b, p.df, +!!inline].forEach((n, j) =>
      v.setUint32(at + j * 4, n, true),
    );
    v.setFloat64(at + 16, p.occurrences, true);
    ref.forEach((n, j) => v.setUint32(at + 24 + j * 4, n, true));
    if (inline) {
      parts.push(inline);
      offset += inline.length;
    }
  });
  return concat(parts);
}
export class PairDirectory {
  private v: DataView;
  readonly count: number;
  constructor(
    readonly bytes: Uint8Array,
    readonly address: Ref,
  ) {
    this.v = view(bytes);
    if (
      bytes.length < HEADER ||
      this.v.getUint32(0, true) !== 0x31445043 ||
      this.v.getUint32(8, true) !== ENTRY
    )
      throw Error("Invalid pair directory");
    this.count = this.v.getUint32(4, true);
    const start = HEADER + this.count * ENTRY;
    if (
      !this.count ||
      this.count > 4096 ||
      start > bytes.length ||
      this.v.getUint32(12, true) !== start ||
      address[2] !== bytes.length
    )
      throw Error("Invalid pair directory size");
    let next = start;
    for (let i = 0; i < this.count; i++) {
      const p = HEADER + i * ENTRY,
        flags = this.v.getUint32(p + 12, true),
        offset = this.v.getUint32(p + 28, true),
        length = this.v.getUint32(p + 32, true),
        df = this.v.getUint32(p + 8, true),
        occurrences = this.v.getFloat64(p + 16, true);
      if (
        (i && comparePair(this.key(i - 1), this.key(i)) >= 0) ||
        flags > 1 ||
        !df ||
        !length ||
        !Number.isSafeInteger(occurrences) ||
        occurrences < df ||
        this.v.getUint32(p + 36, true) ||
        (flags &&
          (this.v.getUint32(p + 24, true) !== 0 ||
            offset !== next ||
            offset + length > bytes.length))
      )
        throw Error("Invalid pair directory order/address");
      if (flags) next += length;
    }
    if (next !== bytes.length) throw Error("Trailing pair directory bytes");
  }
  key(i: number): [number, number] {
    const p = HEADER + i * ENTRY;
    return [this.v.getUint32(p, true), this.v.getUint32(p + 4, true)];
  }
  lookup(a: number, b: number): PositionalPair | undefined {
    let lo = 0,
      hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (comparePair(this.key(mid), [a, b]) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.count || comparePair(this.key(lo), [a, b])) return;
    const p = HEADER + lo * ENTRY,
      inline = this.v.getUint32(p + 12, true),
      offset = this.v.getUint32(p + 28, true);
    return {
      a,
      b,
      df: this.v.getUint32(p + 8, true),
      occurrences: this.v.getFloat64(p + 16, true),
      ref: [
        inline ? this.address[0] : this.v.getUint32(p + 24, true),
        inline ? this.address[1] + offset : offset,
        this.v.getUint32(p + 32, true),
      ],
    };
  }
}
export function pairDirectoryShard(
  shards: PairDirectoryShard[],
  a: number,
  b: number,
) {
  let lo = 0,
    hi = shards.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comparePair(shards[mid].first, [a, b]) <= 0) lo = mid + 1;
    else hi = mid;
  }
  const shard = shards[lo - 1];
  return shard && comparePair(shard.last, [a, b]) >= 0 ? shard : undefined;
}
