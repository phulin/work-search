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
    if (bytes.length !== 16 + this.count * 16)
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
export function statisticsOutput(rows: number, first: number, end: number) {
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
/** Sort numeric occurrence keys per document, then merge document counts.
 * Memory follows actual occurrences, never the square of the vocabulary. */
export function documentGroupPairStatistics(
  bytes: Uint8Array,
  offsets: Uint32Array,
  first: number,
  termIds: number[],
) {
  if (
    !termIds.length ||
    termIds.length > 65536 ||
    new Set(termIds).size !== termIds.length ||
    offsets.length < 2 ||
    offsets[0] !== 0 ||
    offsets.at(-1) !== bytes.length
  )
    throw Error("Invalid pair statistics input");
  const ranks = new Map(termIds.map((id, i) => [id, i])),
    width = termIds.length;
  let runs: PairStatistics[] = [];
  for (let row = 0; row + 1 < offsets.length; row++) {
    const pkg = new DocumentPackage(
      bytes.subarray(offsets[row], offsets[row + 1]),
      first + row,
    );
    const fields = [pkg.tokens(0), pkg.tokens(1)],
      keys = new Uint32Array(fields[0].length + fields[1].length);
    let count = 0;
    for (const tokens of fields) {
      let a = tokens.length ? ranks.get(tokens[0]) : undefined;
      for (let p = 1; p < tokens.length; p++) {
        const b = ranks.get(tokens[p]);
        if (a !== undefined && b !== undefined) {
          keys[count++] = a * width + b;
        }
        a = b;
      }
    }
    const sorted = keys.subarray(0, count);
    sorted.sort();
    let unique = 0;
    for (let i = 0; i < count; i++)
      if (!i || sorted[i] !== sorted[i - 1]) unique++;
    const result = statisticsOutput(unique, first + row, first + row + 1);
    let out = 0;
    for (let i = 0; i < count;) {
      let end = i + 1;
      while (end < count && sorted[end] === sorted[i]) end++;
      result.put(out++, sorted[i], 1, end - i);
      i = end;
    }
    runs.push(new PairStatistics(result.finish(out)));
  }
  while (runs.length > 1) {
    const next: PairStatistics[] = [];
    for (let i = 0; i < runs.length; i += 4)
      next.push(new PairStatistics(mergePairStatistics(runs.slice(i, i + 4))));
    runs = next;
  }
  return runs[0].bytes;
}
/** Small local merges. Corpus-wide merges stream bounded physical chunks. */
export function mergePairStatistics(inputs: PairStatistics[]) {
  if (!inputs.length || inputs.length > 4)
    throw Error("Pair statistics merge requires 1–4 runs");
  if (inputs.some((s, i) => i > 0 && s.first !== inputs[i - 1].end))
    throw Error("Pair statistics coverage gap or overlap");
  const cursors = new Uint32Array(inputs.length),
    result = statisticsOutput(
      inputs.reduce((n, s) => n + s.count, 0),
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
