import { lower } from "../columnar/format.js";
import type { PhraseExecution } from "../columnar/search.js";
import type { Node } from "../query/parser.js";
import type { SuffixReader } from "./reader.js";
import {
  arrayCursor,
  intersectCursors,
  unionCursors,
} from "../columnar/numeric-cursor.js";
import type { MembershipAnchor } from "../columnar/membership-anchor.js";
import { canonicalBit } from "./format.js";
interface PhraseRows {
  docs: Uint32Array;
  offsets?: [Uint32Array, Uint32Array];
  positions?: [Uint32Array, Uint32Array];
  fields?: [Uint32Array, Uint32Array];
}
/** Query-local sorted numeric evidence for intervals that fit the active-memory
 * budget. Broad standalone phrases use the streaming ranker instead. */
export class SuffixEvidence implements PhraseExecution {
  readonly plans = [];
  private rows = new Map<string, PhraseRows>();
  private lo = 0;
  private hi = 0;
  private reserved = 0;
  private anchors = new WeakMap<
    Node,
    Map<string, MembershipAnchor | undefined>
  >();
  async add(
    words: string[],
    ids: Uint32Array,
    reader: SuffixReader,
    budget = 4 * 1048576,
    needPositions = true,
  ) {
    const existing = this.rows.get(words.join("\0"));
    if (existing && (!needPositions || existing.positions)) return true;
    if (
      reader.minimumRows(ids) * 40 + this.bufferBytes + this.reserved >
      budget
    )
      return false;
    const positions = needPositions || ids.length < 2 || ids.length > 5,
      columns = positions
        ? (["documents", "positions"] as const)
        : (["documents", "flags"] as const);
    const estimated =
      ids.length <= 8
        ? await reader.numericInterval(ids, [...columns])
        : await reader.interval(ids);
    const reserve = (estimated.end - estimated.first) * 40;
    if (reserve + this.bufferBytes + this.reserved > budget) return false;
    this.reserved += reserve;
    try {
      const interval =
          "groups" in estimated
            ? await reader.expand(estimated, [...columns])
            : estimated,
        docValues: number[] = [],
        positionValues: number[] = [];
      if (!positions) {
        const fields: [number[], number[]] = [[], []],
          bodyBit = canonicalBit(ids.length, "body"),
          titleBit = canonicalBit(ids.length, "title");
        for await (const batch of reader.scan(interval, [...columns])) {
          const d = batch.columns.documents!,
            f = batch.columns.flags!,
            docs = new DataView(d.buffer, d.byteOffset, d.byteLength),
            flags = new DataView(f.buffer, f.byteOffset, f.byteLength);
          for (let i = batch.first; i < batch.end; i++) {
            const code = flags.getUint16(i * 2, true);
            if (code & bodyBit) fields[0].push(docs.getUint32(i * 4, true));
            if (code & titleBit) fields[1].push(docs.getUint32(i * 4, true));
          }
        }
        const sorted = fields.map((values) => {
            const docs = Uint32Array.from(values).sort();
            let count = 0;
            for (let i = 0; i < docs.length; i++)
              if (!i || docs[i] !== docs[i - 1]) docs[count++] = docs[i];
            return docs.subarray(0, count);
          }) as [Uint32Array, Uint32Array],
          cursor = unionCursors(arrayCursor(sorted[0]), arrayCursor(sorted[1])),
          all = new Uint32Array(sorted[0].length + sorted[1].length);
        let count = 0;
        for (let doc = cursor.next(); doc !== Infinity; doc = cursor.next())
          all[count++] = doc;
        this.rows.set(words.join("\0"), {
          docs: all.length === count ? all : all.slice(0, count),
          fields: sorted,
        });
        this.anchors = new WeakMap();
        return true;
      }
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
      this.anchors = new WeakMap();
      return true;
    } finally {
      this.reserved -= reserve;
    }
  }
  /** Exact phrase lists also supply a conservative Boolean candidate stream.
   * Unknown is the universe; OR requires both branches, and negative evidence
   * is never subtracted from a superset. All work stays in sorted integers. */
  candidateAnchor(
    ast: Node,
    field: "all" | "body" | "title",
  ): MembershipAnchor | undefined {
    const cached = this.anchors.get(ast);
    if (cached?.has(field)) return cached.get(field);
    const visit = (n: Node): Uint32Array | undefined => {
      if (n.kind === "phrase") {
        const row = this.rows.get(n.terms.join("\0"));
        if (!row) return;
        if (field === "all") return row.docs;
        const f = field === "title" ? 1 : 0;
        if (row.fields) return row.fields[f];
        return row.docs.filter(
          (_, i) => row.offsets![f][i + 1] > row.offsets![f][i],
        );
      }
      if (n.kind === "empty") return EMPTY;
      if (!("left" in n)) return;
      const a = visit(n.left);
      if (n.kind === "except") return a;
      const b = visit(n.right);
      if (n.kind === "or" && (!a || !b)) return;
      if (!a) return b;
      if (!b) return a;
      const cursor =
          n.kind === "or"
            ? unionCursors(arrayCursor(a), arrayCursor(b))
            : intersectCursors([arrayCursor(a), arrayCursor(b)]),
        docs = new Uint32Array(
          n.kind === "or" ? a.length + b.length : Math.min(a.length, b.length),
        );
      let count = 0;
      for (let doc = cursor.next(); doc !== Infinity; doc = cursor.next())
        docs[count++] = doc;
      return docs.subarray(0, count);
    };
    const docs = visit(ast);
    const result: MembershipAnchor | undefined = docs
      ? {
          count: docs.length,
          bufferBytes: docs.buffer.byteLength,
          values: function* () {
            yield* docs;
          },
          has: (doc) => docs[lower(docs, doc)] === doc,
          cursor: () => arrayCursor(docs),
          covered: this.covered,
          evidence: this.evidence,
        }
      : undefined;
    const fields = cached ?? new Map<string, MembershipAnchor | undefined>();
    fields.set(field, result);
    this.anchors.set(ast, fields);
    return result;
  }
  covered = (words: string[]) => this.rows.has(words.join("\0"));
  evidence = (words: string[], doc: number, field: number) => {
    const rows = this.rows.get(words.join("\0"));
    if (!rows) return;
    if (rows.fields) {
      const docs = rows.fields[field];
      return docs[lower(docs, doc)] === doc ? undefined : EMPTY;
    }
    const i = lower(rows.docs, doc);
    return rows.docs[i] === doc
      ? rows.positions![field].subarray(
          rows.offsets![field][i],
          rows.offsets![field][i + 1],
        )
      : EMPTY;
  };
  truth = (words: string[], doc: number, field: number) => {
    const row = this.rows.get(words.join("\0"));
    if (row?.fields) {
      const docs = row.fields[field];
      return docs[lower(docs, doc)] === doc;
    }
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
        (r.fields
          ? r.fields[0].byteLength + r.fields[1].byteLength
          : r.offsets![0].byteLength +
            r.offsets![1].byteLength +
            r.positions![0].byteLength +
            r.positions![1].byteLength),
      0,
    );
  }
  mask(ast: Node, field: "all" | "body" | "title") {
    // Three-valued Boolean evaluation: positions establish phrases, but words
    // and proximity relations remain unknown until the normal exact evaluator.
    const size = this.hi - this.lo;
    type Truth = number | Uint8Array<ArrayBuffer>;
    const visit = (n: Node): Truth => {
      if (n.kind === "empty") return 0;
      if (n.kind === "all") return 1;
      if (n.kind === "term") return 2;
      if (n.kind === "phrase") {
        const rows = this.rows.get(n.terms.join("\0"));
        if (!rows) return 2;
        if (rows.fields) {
          const docs =
              field === "all"
                ? rows.docs
                : rows.fields[field === "body" ? 0 : 1],
            first = lower(docs, this.lo),
            end = lower(docs, this.hi);
          if (first === end) return 0;
          if (end - first === size) return 1;
          const values = new Uint8Array(size);
          for (let i = first; i < end; i++) values[docs[i] - this.lo] = 1;
          return values;
        }
        const first = lower(rows.docs, this.lo),
          end = lower(rows.docs, this.hi);
        if (first === end) return 0;
        if (field === "all" && end - first === size) return 1;
        let a: Uint8Array<ArrayBuffer> | undefined;
        for (let i = first; i < end; i++)
          if (
            field === "all" ||
            (field !== "title" &&
              rows.offsets![0][i + 1] > rows.offsets![0][i]) ||
            (field !== "body" && rows.offsets![1][i + 1] > rows.offsets![1][i])
          )
            (a ??= new Uint8Array(size))[rows.docs[i] - this.lo] = 1;
        return a ?? 0;
      }
      if (n.kind === "not") {
        const a = visit(n.child);
        if (typeof a === "number") return a === 2 ? 2 : 1 - a;
        for (let i = 0; i < size; i++) if (a[i] !== 2) a[i] = 1 - a[i];
        return a;
      }
      const a = visit(n.left);
      if (a === 0 && n.kind !== "or") return 0;
      if (a === 1 && n.kind === "or") return 1;
      const b = visit(n.right),
        table = TRUTH_TABLES[n.kind];
      if (typeof a === "number" && typeof b === "number")
        return table[a * 3 + b];
      // Every recursive result owns its temporary array. Reuse it instead of
      // allocating another window and branching on the operator per document.
      if (typeof a === "number" || typeof b === "number") {
        const left = typeof a === "number",
          scalar = (left ? a : b) as number,
          array = (left ? b : a) as Uint8Array<ArrayBuffer>,
          x = table[left ? scalar * 3 : scalar],
          y = table[left ? scalar * 3 + 1 : 3 + scalar],
          z = table[left ? scalar * 3 + 2 : 6 + scalar];
        if (x === y && y === z) return x;
        if (x === 0 && y === 1 && z === 2) return array;
        for (let i = 0; i < size; i++)
          array[i] =
            table[left ? scalar * 3 + array[i] : array[i] * 3 + scalar];
        return array;
      }
      for (let i = 0; i < size; i++) a[i] = table[a[i] * 3 + b[i]];
      return a;
    };
    const value = visit(ast);
    if (typeof value === "number")
      return new Uint8Array(size).fill(value === 0 ? 0 : 1);
    for (let i = 0; i < size; i++) if (value[i]) value[i] = 1;
    return value;
  }
}
const EMPTY = new Uint32Array();
// False / true / unknown. Phrase membership alone cannot prove proximity.
const TRUTH_TABLES = {
  and: [0, 0, 0, 0, 1, 2, 0, 2, 2],
  or: [0, 1, 2, 1, 1, 1, 2, 1, 2],
  except: [0, 0, 0, 1, 0, 2, 2, 0, 2],
  near: [0, 0, 0, 0, 2, 2, 0, 2, 2],
} as const;
