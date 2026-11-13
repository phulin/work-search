import type { Node } from "./parser.js";
import {
  readVarint,
  positionRowEnd,
  type DecodedPostings,
} from "../format/codec.js";
import { intersect, union, difference } from "./sets.js";
export interface Span {
  field: "body" | "title";
  start: number;
  end: number;
}
export class QueryResourceError extends Error {}
export function candidateDocuments(
  ast: Node,
  lists: Map<string, DecodedPostings>,
  count: number,
  field: "all" | "body" | "title",
  exact: boolean,
): Uint32Array {
  const cache = new Map<string, Uint32Array>();
  let universe: Uint32Array | undefined;
  const all = () =>
    (universe ??= Uint32Array.from({ length: count }, (_, i) => i));
  function term(t: string) {
    let docs = cache.get(t);
    if (!docs) {
      const l = lists.get(t);
      docs = l
        ? field === "all"
          ? l.docs
          : l.docs.filter((_, i) => l[field][i] > 0)
        : new Uint32Array(0);
      cache.set(t, docs);
    }
    return docs;
  }
  function conjunction(nodes: Node[]) {
    const arrays = nodes.map(visit).sort((a, b) => a.length - b.length);
    let result = arrays[0] ?? new Uint32Array(0);
    for (let i = 1; i < arrays.length && result.length; i++)
      result = intersect(result, arrays[i]);
    return result;
  }
  function visit(n: Node): Uint32Array {
    if (n.kind === "empty") return new Uint32Array(0);
    if (n.kind === "all") return all();
    if (n.kind === "term") return term(n.term);
    if (n.kind === "phrase")
      return conjunction(
        [...new Set(n.terms)].map((term) => ({ kind: "term", term })),
      );
    if (n.kind === "not")
      return exact ? difference(all(), visit(n.child)) : all();
    if (n.kind === "and") {
      const flattened: Node[] = [];
      const collect = (x: Node) => {
        if (x.kind === "and") {
          collect(x.left);
          collect(x.right);
        } else flattened.push(x);
      };
      collect(n);
      return conjunction(flattened);
    }
    if (n.kind === "or") return union(visit(n.left), visit(n.right));
    if (n.kind === "except")
      return exact ? difference(visit(n.left), visit(n.right)) : visit(n.left);
    return intersect(visit(n.left), visit(n.right));
  }
  return visit(ast);
}
interface SpanList {
  starts: ArrayLike<number>;
  ends: ArrayLike<number>;
  count: number;
  monotone: boolean;
}
const EMPTY: SpanList = { starts: [], ends: [], count: 0, monotone: true };
class SpanBuffer implements SpanList {
  constructor(
    private readonly reserve: (n: number) => void,
    private readonly limit = 4096,
  ) {}
  starts = new Uint32Array(0);
  ends = new Uint32Array(0);
  count = 0;
  monotone = true;
  reset() {
    this.count = 0;
    this.monotone = true;
  }
  add(start: number, end: number) {
    if (this.count >= this.limit)
      throw new QueryResourceError("Too many positional spans in one document");
    if (this.count >= this.starts.length) {
      const size = Math.min(this.limit, Math.max(16, this.starts.length * 2));
      this.reserve(size - this.starts.length);
      const starts = new Uint32Array(size),
        ends = new Uint32Array(size);
      starts.set(this.starts);
      ends.set(this.ends);
      this.starts = starts;
      this.ends = ends;
    }
    this.starts[this.count] = start;
    this.ends[this.count++] = end;
  }
  normalize(alreadySorted = false) {
    if (this.count < 2) return this;
    if (alreadySorted) {
      for (let i = 1; i < this.count; i++)
        if (this.ends[i] < this.ends[i - 1]) this.monotone = false;
      return this;
    }
    // Only nested expressions materialize spans. Their ordering is part of the
    // interval-join contract; ends need not be monotone even when starts are.
    const order = Uint32Array.from({ length: this.count }, (_, i) => i).sort(
      (a, b) => this.starts[a] - this.starts[b] || this.ends[a] - this.ends[b],
    );
    const starts = order.map((i) => this.starts[i]),
      ends = order.map((i) => this.ends[i]);
    this.count = 0;
    for (let i = 0; i < order.length; i++) {
      if (
        this.count &&
        starts[i] === this.starts[this.count - 1] &&
        ends[i] === this.ends[this.count - 1]
      )
        continue;
      if (this.count && ends[i] < this.ends[this.count - 1])
        this.monotone = false;
      this.starts[this.count] = starts[i];
      this.ends[this.count++] = ends[i];
    }
    return this;
  }
}
class TermCursor {
  private cursor = 0;
  private rowDoc = -1;
  private rowValue = -1;
  private decodedDoc = -1;
  private buffers = [new Uint32Array(0), new Uint32Array(0)];
  private runs: SpanList[] = [{ ...EMPTY }, { ...EMPTY }];
  private byteCursor = { i: 0 };
  constructor(
    readonly list: DecodedPostings | undefined,
    readonly field: "all" | "body" | "title",
    readonly direct?: (
      doc: number,
      field: number,
    ) => ArrayLike<number> | undefined,
  ) {}
  row(doc: number) {
    if (this.rowDoc === doc) return this.rowValue;
    const l = this.list;
    this.rowDoc = doc;
    if (!l) return (this.rowValue = -1);
    let p = this.cursor;
    if (p > 0 && l.docs[p - 1] >= doc) p = 0;
    // A few sequential steps handle dense candidates; galloping/binary search
    // avoids walking a million common postings for a sparse candidate set.
    let steps = 0;
    while (p < l.docs.length && l.docs[p] < doc && steps++ < 8) p++;
    if (p < l.docs.length && l.docs[p] < doc) {
      let hi = p + 1,
        stride = 1;
      while (hi < l.docs.length && l.docs[hi] < doc) {
        stride *= 2;
        hi = Math.min(l.docs.length, hi + stride);
      }
      let lo = p;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (l.docs[m] < doc) lo = m + 1;
        else hi = m;
      }
      p = lo;
    }
    this.cursor = p;
    return (this.rowValue = l.docs[p] === doc ? p : -1);
  }
  present(doc: number) {
    const row = this.row(doc),
      l = this.list;
    return row >= 0 && !!l && (this.field === "all" || l[this.field][row] > 0);
  }
  positions(doc: number, field: number): SpanList {
    if (this.direct) {
      const wanted =
          this.field === "all" ||
          this.field === (field === 0 ? "body" : "title"),
        a = wanted ? this.direct(doc, field) : undefined;
      return a
        ? { starts: a, ends: a, count: a.length, monotone: true }
        : EMPTY;
    }
    if (this.decodedDoc !== doc) {
      const row = this.row(doc),
        l = this.list;
      this.runs[0].count = this.runs[1].count = 0;
      if (row >= 0 && l) {
        if (!l.positionOffsets) throw new Error("Positions unavailable");
        const p = this.byteCursor;
        const bytes = l.bytes;
        const rowEnd = positionRowEnd(l, row);
        p.i = l.positionOffsets[row];
        for (let f = 0; f < 2; f++) {
          const count = f === 0 ? l.body[row] : l.title[row],
            wanted =
              this.field === "all" ||
              this.field === (f === 0 ? "body" : "title");
          if (wanted && this.buffers[f].length < count)
            this.buffers[f] = new Uint32Array(count);
          const buffer = this.buffers[f];
          let position = 0;
          for (let i = 0; i < count; i++) {
            // decodePostings already validated this immutable byte stream.
            const byte = bytes[p.i];
            const delta = byte < 128 ? (p.i++, byte) : readVarint(bytes, p);
            if (rowEnd !== undefined && i && !delta)
              throw new Error("Unsorted positions");
            position += delta;
            if (rowEnd !== undefined && position > 0xffffffff)
              throw new Error("Position overflow");
            if (wanted) buffer[i] = position;
          }
          this.runs[f].starts = this.runs[f].ends = buffer;
          this.runs[f].count = wanted ? count : 0;
          if (this.field === "body" && rowEnd === undefined) break;
        }
        if (rowEnd !== undefined && p.i !== rowEnd)
          throw new Error("Trailing position data");
      }
      this.decodedDoc = doc;
    }
    return this.runs[field];
  }
}
interface Plan {
  truth(): boolean;
  spans(field: number): SpanList;
  cost: number;
}
/** Query-local compiled plans, reusable position scratch, no per-document Maps. */
export function positionalMatcher(
  ast: Node,
  lists: Map<string, DecodedPostings>,
  field: "all" | "body" | "title",
  direct?: (
    term: string,
    doc: number,
    field: number,
  ) => ArrayLike<number> | undefined,
  limits: { spans?: number; scratchSpans?: number; checks?: number } = {},
  phraseEvidence?: (
    words: string[],
    doc: number,
    field: number,
  ) => ArrayLike<number> | undefined,
) {
  let document = 0,
    epoch = 0,
    checks = 0,
    scratchSpans = 0;
  const terms = new Map<string, TermCursor>();
  const term = (name: string) => {
    let t = terms.get(name);
    if (!t) {
      t = new TermCursor(
        lists.get(name),
        field,
        direct ? (doc, f) => direct(name, doc, f) : undefined,
      );
      terms.set(name, t);
    }
    return t;
  };
  const tick = () => {
    if (++checks > (limits.checks ?? 10000000))
      throw new QueryResourceError("Positional work limit exceeded");
  };
  const fields = field === "body" ? [0] : field === "title" ? [1] : [0, 1];
  function lower(list: SpanList, target: number) {
    let l = 0,
      r = list.count;
    while (l < r) {
      tick();
      const m = (l + r) >>> 1;
      if (list.starts[m] < target) l = m + 1;
      else r = m;
    }
    return l;
  }
  function orderedExists(a: SpanList, b: SpanList, n: number) {
    if (!a.count || !b.count) return false;
    let j = 0;
    for (let i = 0; i < a.count; i++) {
      if (a.monotone) {
        while (j < b.count && b.starts[j] <= a.ends[i]) {
          tick();
          j++;
        }
      } else j = lower(b, a.ends[i] + 1);
      if (a.monotone && j === b.count) return false;
      tick();
      if (j < b.count && b.starts[j] - a.ends[i] <= n) return true;
    }
    return false;
  }
  function emitNear(out: SpanBuffer, a: SpanList, b: SpanList, n: number) {
    for (let i = 0; i < a.count; i++)
      for (
        let j = lower(b, a.ends[i] + 1);
        j < b.count && b.starts[j] - a.ends[i] <= n;
        j++
      ) {
        tick();
        out.add(a.starts[i], b.ends[j]);
      }
  }
  function compile(node: Node): Plan {
    const left = "left" in node ? compile(node.left) : undefined,
      right = "right" in node ? compile(node.right) : undefined,
      child = node.kind === "not" ? compile(node.child) : undefined;
    const cursor = node.kind === "term" ? term(node.term) : undefined;
    const phrase = node.kind === "phrase" ? node.terms.map(term) : undefined;
    const pointers = phrase
      ? [new Uint32Array(phrase.length), new Uint32Array(phrase.length)]
      : undefined;
    const phraseLists = phrase
      ? [new Array<SpanList>(phrase.length), new Array<SpanList>(phrase.length)]
      : undefined;
    const reserve = (n: number) => {
      if ((scratchSpans += n) > (limits.scratchSpans ?? 32768))
        throw new QueryResourceError("Positional scratch limit exceeded");
    };
    const buffers = [
      new SpanBuffer(reserve, limits.spans),
      new SpanBuffer(reserve, limits.spans),
    ];
    let truthEpoch = -1,
      truthValue = false;
    const spanEpoch = [-1, -1];
    function phraseMatch(f: number, out?: SpanBuffer) {
      // Undefined means unknown. An empty exact occurrence list proves absence,
      // including underneath NOT; partial accelerator matches cannot prove it.
      const evidence =
        node.kind === "phrase"
          ? phraseEvidence?.(node.terms, document, f)
          : undefined;
      if (evidence !== undefined) {
        if (out)
          for (let i = 0; i < evidence.length; i++) {
            tick();
            out.add(evidence[i], evidence[i] + phrase!.length - 1);
          }
        return evidence.length > 0;
      }
      const arrays = phraseLists![f],
        p = pointers![f];
      let anchor = 0;
      for (let i = 0; i < phrase!.length; i++) {
        arrays[i] = phrase![i].positions(document, f);
        if (!arrays[i].count) return false;
        if (arrays[i].count < arrays[anchor].count) anchor = i;
      }
      p.fill(0);
      let matched = false;
      for (let i = 0; i < arrays[anchor].count; i++) {
        const start = arrays[anchor].starts[i] - anchor;
        if (start < 0) continue;
        let valid = true;
        for (let j = 0; j < arrays.length; j++) {
          if (j === anchor) continue;
          const a = arrays[j],
            target = start + j;
          while (p[j] < a.count && a.starts[p[j]] < target) {
            tick();
            p[j]++;
          }
          tick();
          if (p[j] === a.count) return matched;
          if (a.starts[p[j]] !== target) {
            valid = false;
            break;
          }
        }
        if (valid) {
          if (!out) return true;
          out.add(start, start + arrays.length - 1);
          matched = true;
        }
      }
      return matched;
    }
    function spans(f: number): SpanList {
      if (cursor) return cursor.positions(document, f);
      if (spanEpoch[f] === epoch) return buffers[f];
      const out = buffers[f];
      out.reset();
      if (phrase) phraseMatch(f, out);
      else if (node.kind === "near") {
        const a = left!.spans(f),
          b = right!.spans(f);
        emitNear(out, a, b, node.distance);
        if (!node.ordered) emitNear(out, b, a, node.distance);
      } else if (node.kind === "or") {
        const a = left!.spans(f),
          b = right!.spans(f);
        let i = 0,
          j = 0;
        while (i < a.count || j < b.count) {
          tick();
          const useA =
            j === b.count ||
            (i < a.count &&
              (a.starts[i] < b.starts[j] ||
                (a.starts[i] === b.starts[j] && a.ends[i] <= b.ends[j])));
          const start = useA ? a.starts[i] : b.starts[j],
            end = useA ? a.ends[i++] : b.ends[j++];
          if (
            !out.count ||
            out.starts[out.count - 1] !== start ||
            out.ends[out.count - 1] !== end
          )
            out.add(start, end);
        }
      } else if (node.kind === "and") {
        if (left!.truth() && right!.truth()) {
          const a = left!.spans(f),
            b = right!.spans(f);
          // An unanchored true complement can filter the other anchored side,
          // but a positive condition found only in another field cannot.
          const aElse = a.count
              ? true
              : fields.some((g) => g !== f && left!.spans(g).count > 0),
            bElse = b.count
              ? true
              : fields.some((g) => g !== f && right!.spans(g).count > 0);
          if (!a.count && !aElse) {
            for (let j = 0; j < b.count; j++) out.add(b.starts[j], b.ends[j]);
          } else if (!b.count && !bElse) {
            for (let i = 0; i < a.count; i++) out.add(a.starts[i], a.ends[i]);
          } else
            for (let i = 0; i < a.count; i++)
              for (let j = 0; j < b.count; j++) {
                tick();
                out.add(
                  Math.min(a.starts[i], b.starts[j]),
                  Math.max(a.ends[i], b.ends[j]),
                );
              }
        }
      } else if (node.kind === "except") {
        if (!right!.truth()) {
          const a = left!.spans(f);
          for (let i = 0; i < a.count; i++) out.add(a.starts[i], a.ends[i]);
        }
      }
      out.normalize(node.kind === "or" || !!phrase);
      spanEpoch[f] = epoch;
      return out;
    }
    function truth() {
      if (truthEpoch === epoch) return truthValue;
      let result = false;
      if (cursor) result = cursor.present(document);
      else if (phrase) result = fields.some((f) => phraseMatch(f));
      else if (node.kind === "near")
        result = fields.some((f) => {
          const a = left!.spans(f),
            b = right!.spans(f);
          return (
            orderedExists(a, b, node.distance) ||
            (!node.ordered && orderedExists(b, a, node.distance))
          );
        });
      else if (node.kind === "all") result = true;
      else if (node.kind === "not") result = !child!.truth();
      else if (node.kind === "except")
        result = !right!.truth() && left!.truth();
      else if (node.kind === "and")
        result =
          left!.cost <= right!.cost
            ? left!.truth() && right!.truth()
            : right!.truth() && left!.truth();
      else if (node.kind === "or")
        result =
          left!.cost <= right!.cost
            ? left!.truth() || right!.truth()
            : right!.truth() || left!.truth();
      truthEpoch = epoch;
      return (truthValue = result);
    }
    return {
      truth,
      spans,
      cost: cursor
        ? 1
        : phrase || node.kind === "near"
          ? 100
          : child
            ? child.cost + 1
            : (left?.cost ?? 0) + (right?.cost ?? 0),
    };
  }
  const plan = compile(ast);
  return Object.assign(
    (doc: number) => {
      document = doc;
      epoch++;
      return plan.truth();
    },
    {
      firstBodySpan(doc: number) {
        document = doc;
        epoch++;
        const spans = plan.spans(0);
        return spans.count
          ? { start: spans.starts[0], end: spans.ends[0] }
          : undefined;
      },
    },
  );
}
