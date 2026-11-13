import { DocumentPackage } from "../document-package.js";
import { view } from "../format.js";

/** Fixed-width sorted statistic rows. Counts use float64 so a 10M-document
 * corpus can exceed 2^32 occurrences without corrupting accelerator selection. */
export class PairStatistics {
  readonly data: DataView;
  readonly count: number;
  readonly first: number;
  readonly end: number;
  constructor(readonly bytes: Uint8Array) {
    this.data = view(bytes);
    if (bytes.length < 16 || this.data.getUint32(0, true) !== 0x31535043)
      throw Error("Invalid pair statistics");
    this.count = this.data.getUint32(4, true);
    this.first = this.data.getUint32(8, true);
    this.end = this.data.getUint32(12, true);
    if (this.end <= this.first)
      throw Error("Invalid statistics document range");
    if (this.count > 1048576 || bytes.length !== 16 + this.count * 16)
      throw Error("Invalid pair statistics count");
    for (let i = 0; i < this.count; i++)
      if (
        (i && this.key(i) <= this.key(i - 1)) ||
        !this.df(i) ||
        this.df(i) > this.end - this.first ||
        !Number.isSafeInteger(this.occurrences(i)) ||
        this.occurrences(i) < this.df(i)
      )
        throw Error("Invalid pair statistics order/count");
  }
  key(row: number) {
    return this.data.getUint32(16 + row * 16, true);
  }
  df(row: number) {
    return this.data.getUint32(20 + row * 16, true);
  }
  occurrences(row: number) {
    return this.data.getFloat64(24 + row * 16, true);
  }
}
function output(rows: number, first: number, end: number) {
  const bytes = new Uint8Array(16 + rows * 16),
    data = view(bytes);
  data.setUint32(0, 0x31535043, true);
  data.setUint32(8, first, true);
  data.setUint32(12, end, true);
  return {
    bytes,
    data,
    put(row: number, key: number, df: number, occurrences: number) {
      if (
        !Number.isSafeInteger(occurrences) ||
        occurrences < df ||
        df > 0xffffffff
      )
        throw Error("Pair statistic overflow");
      data.setUint32(16 + row * 16, key, true);
      data.setUint32(20 + row * 16, df, true);
      data.setFloat64(24 + row * 16, occurrences, true);
    },
    finish(count: number) {
      data.setUint32(4, count, true);
      return bytes.subarray(0, 16 + count * 16);
    },
  };
}
/** One immutable physical document group is one statistics job. Display sections
 * stay compressed. The dense rank table is bounded by 1,024 corpus-selected IDs. */
export function documentGroupPairStatistics(
  bytes: Uint8Array,
  offsets: Uint32Array,
  first: number,
  termIds: number[],
) {
  if (
    !termIds.length ||
    termIds.length > 1024 ||
    new Set(termIds).size !== termIds.length ||
    offsets.length < 2 ||
    offsets[0] !== 0 ||
    offsets.at(-1) !== bytes.length
  )
    throw Error("Invalid pair statistics input");
  const ranks = new Map(termIds.map((id, i) => [id, i])),
    width = termIds.length,
    df = new Uint32Array(width * width),
    occurrences = new Float64Array(df.length),
    stamp = new Uint32Array(df.length),
    keys = new Uint32Array(df.length);
  let count = 0;
  for (let row = 0; row + 1 < offsets.length; row++) {
    const pkg = new DocumentPackage(
      bytes.subarray(offsets[row], offsets[row + 1]),
      first + row,
    );
    for (let field = 0; field < 2; field++) {
      const tokens = pkg.tokens(field);
      let a = tokens.length ? ranks.get(tokens[0]) : undefined;
      for (let p = 1; p < tokens.length; p++) {
        const b = ranks.get(tokens[p]);
        if (a !== undefined && b !== undefined) {
          const key = a * width + b;
          if (!df[key]) keys[count++] = key;
          if (stamp[key] !== row + 1) {
            stamp[key] = row + 1;
            df[key]++;
          }
          occurrences[key]++;
        }
        a = b;
      }
    }
  }
  const sorted = keys.subarray(0, count);
  sorted.sort();
  const result = output(count, first, first + offsets.length - 1);
  for (let i = 0; i < count; i++)
    result.put(i, sorted[i], df[sorted[i]], occurrences[sorted[i]]);
  return result.finish(count);
}
/** Four-way fan-in bounds input buffers even when all 1,024² pairs occur.
 * Multiple merge levels replace a single unbounded all-run aggregation. */
export function mergePairStatistics(inputs: PairStatistics[]) {
  if (!inputs.length || inputs.length > 4)
    throw Error("Pair statistics merge requires 1–4 runs");
  if (inputs.some((s, i) => i > 0 && s.first !== inputs[i - 1].end))
    throw Error("Pair statistics coverage gap or overlap");
  const cursors = new Uint32Array(inputs.length),
    result = output(
      Math.min(
        1048576,
        inputs.reduce((n, s) => n + s.count, 0),
      ),
      inputs[0].first,
      inputs.at(-1)!.end,
    );
  let count = 0;
  for (;;) {
    let key = Infinity;
    for (let i = 0; i < inputs.length; i++)
      if (cursors[i] < inputs[i].count)
        key = Math.min(key, inputs[i].key(cursors[i]));
    if (key === Infinity) break;
    let df = 0,
      occurrences = 0;
    for (let i = 0; i < inputs.length; i++)
      if (cursors[i] < inputs[i].count && inputs[i].key(cursors[i]) === key) {
        df += inputs[i].df(cursors[i]);
        occurrences += inputs[i].occurrences(cursors[i]++);
      }
    result.put(count++, key, df, occurrences);
  }
  return result.finish(count);
}
