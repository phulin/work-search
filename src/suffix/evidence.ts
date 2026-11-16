import { lower } from "../columnar/format.js";
import type { PhraseExecution } from "../columnar/search.js";
import type { Node } from "../query/parser.js";
import type { SuffixReader } from "./reader.js";
interface PhraseRows {
  docs: Uint32Array;
  offsets: [Uint32Array, Uint32Array];
  positions: [Uint32Array, Uint32Array];
}
/** Query-local sorted numeric evidence for intervals that fit the active-memory
 * budget. Broad standalone phrases use the streaming ranker instead. */
export class SuffixEvidence implements PhraseExecution {
  readonly plans = [];
  private rows = new Map<string, PhraseRows>();
  private lo = 0;
  private hi = 0;
  async add(
    words: string[],
    ids: Uint32Array,
    reader: SuffixReader,
    budget = 4 * 1048576,
  ) {
    if (this.covered(words)) return true;
    const estimated = await reader.interval(ids);
    if ((estimated.end - estimated.first) * 40 + this.bufferBytes > budget)
      return false;
    const interval = await reader.interval(ids),
      docValues: number[] = [],
      positionValues: number[] = [];
    for await (const batch of reader.scan(interval, [
      "documents",
      "positions",
    ])) {
      const d = batch.columns.documents!,
        p = batch.columns.positions!,
        dv = new DataView(d.buffer, d.byteOffset, d.byteLength),
        pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      for (let i = batch.first; i < batch.end; i++) {
        docValues.push(dv.getUint32(i * 4, true));
        positionValues.push(pv.getUint32(i * 4, true));
      }
    }
    const docs = Uint32Array.from(docValues),
      pos = Uint32Array.from(positionValues),
      order = Uint32Array.from({ length: docs.length }, (_, i) => i);
    order.sort((a, b) => docs[a] - docs[b] || pos[a] - pos[b]);
    const unique: number[] = [],
      starts: [number[], number[]] = [[], []],
      offsets: [number[], number[]] = [[0], [0]];
    let last = -1;
    for (const i of order) {
      if (docs[i] !== last) {
        if (last >= 0)
          for (const f of [0, 1]) offsets[f].push(starts[f].length);
        unique.push((last = docs[i]));
      }
      const f = pos[i] >= 2 ** 31 ? 1 : 0;
      starts[f].push(pos[i] % 2 ** 31);
    }
    if (last >= 0) for (const f of [0, 1]) offsets[f].push(starts[f].length);
    this.rows.set(words.join("\0"), {
      docs: Uint32Array.from(unique),
      offsets: [Uint32Array.from(offsets[0]), Uint32Array.from(offsets[1])],
      positions: [Uint32Array.from(starts[0]), Uint32Array.from(starts[1])],
    });
    return true;
  }
  covered = (words: string[]) => this.rows.has(words.join("\0"));
  evidence = (words: string[], doc: number, field: number) => {
    const rows = this.rows.get(words.join("\0"));
    if (!rows) return;
    const i = lower(rows.docs, doc);
    return rows.docs[i] === doc
      ? rows.positions[field].subarray(
          rows.offsets[field][i],
          rows.offsets[field][i + 1],
        )
      : EMPTY;
  };
  truth = (words: string[], doc: number, field: number) => {
    const p = this.evidence(words, doc, field);
    return p === undefined ? undefined : !!p.length;
  };
  positionGuard = () => () => true;
  async window(lo: number, hi: number) {
    this.lo = lo;
    this.hi = hi;
  }
  release(_lo: number) {}
  get bufferBytes() {
    return [...this.rows.values()].reduce(
      (n, r) =>
        n +
        r.docs.byteLength +
        r.offsets[0].byteLength +
        r.offsets[1].byteLength +
        r.positions[0].byteLength +
        r.positions[1].byteLength,
      0,
    );
  }
  mask(ast: Node, field: "all" | "body" | "title") {
    // Three-valued Boolean evaluation: positions establish phrases, but words
    // and proximity relations remain unknown until the normal exact evaluator.
    const size = this.hi - this.lo;
    type Truth = number | Uint8Array;
    const at = (x: Truth, i: number) => (typeof x === "number" ? x : x[i]);
    const visit = (n: Node): Truth => {
      if (n.kind === "empty") return 0;
      if (n.kind === "all") return 1;
      if (n.kind === "term") return 2;
      if (n.kind === "phrase") {
        if (!this.covered(n.terms)) return 2;
        const a = new Uint8Array(size);
        for (let i = 0; i < size; i++)
          a[i] =
            (field !== "title" && this.truth(n.terms, this.lo + i, 0)) ||
            (field !== "body" && this.truth(n.terms, this.lo + i, 1))
              ? 1
              : 0;
        return a;
      }
      if (n.kind === "not") {
        const a = visit(n.child);
        return typeof a === "number"
          ? a === 2
            ? 2
            : 1 - a
          : a.map((v) => (v === 2 ? 2 : 1 - v));
      }
      const a = visit(n.left),
        b = visit(n.right),
        out = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        const x = at(a, i),
          y = at(b, i);
        out[i] =
          n.kind === "or"
            ? x === 1 || y === 1
              ? 1
              : x === 0 && y === 0
                ? 0
                : 2
            : n.kind === "except"
              ? x === 0 || y === 1
                ? 0
                : x === 1 && y === 0
                  ? 1
                  : 2
              : x === 0 || y === 0
                ? 0
                : n.kind !== "near" && x === 1 && y === 1
                  ? 1
                  : 2;
      }
      return out;
    };
    const value = visit(ast);
    return typeof value === "number"
      ? new Uint8Array(size).fill(value === 0 ? 0 : 1)
      : value.map((v) => (v === 0 ? 0 : 1));
  }
}
const EMPTY = new Uint32Array();
