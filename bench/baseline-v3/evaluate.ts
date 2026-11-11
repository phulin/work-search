// Frozen from a68426a for paired correctness/performance comparisons.
import type { Node } from "../../src/query/parser.js";
import { postingPositions, type DecodedPostings } from "../../src/format/codec.js";
import { intersect, union, difference } from "../../src/query/sets.js";
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
// Evaluate one candidate at a time: no corpus-sized map of positional matches.
export function positionalMatcher(
  ast: Node,
  lists: Map<string, DecodedPostings>,
  field: "all" | "body" | "title",
) {
  let document = -1,
    checks = 0;
  const cursors = new Map<string, number>(),
    positionCache = new Map<string, ReturnType<typeof postingPositions>>(),
    spanCache = new Map<Node, Span[]>(),
    truthCache = new Map<Node, boolean>();
  function row(term: string) {
    const l = lists.get(term);
    if (!l) return -1;
    let p = cursors.get(term) ?? 0;
    while (p < l.docs.length && l.docs[p] < document) p++;
    cursors.set(term, p);
    return l.docs[p] === document ? p : -1;
  }
  function positions(term: string) {
    let p = positionCache.get(term);
    if (p) return p;
    const r = row(term),
      l = lists.get(term);
    p =
      r < 0 || !l
        ? { body: new Uint32Array(0), title: new Uint32Array(0) }
        : postingPositions(l, r);
    positionCache.set(term, p);
    return p;
  }
  function bounded(spans: Span[]) {
    if (spans.length > 4096)
      throw new QueryResourceError("Too many positional spans in one document");
    return spans;
  }
  function combine(a: Span[], b: Span[], distance?: number, ordered = false) {
    const out: Span[] = [];
    for (const x of a)
      for (const y of b) {
        if (++checks > 10000000)
          throw new QueryResourceError("Positional work limit exceeded");
        if (x.field !== y.field) continue;
        const gap =
          x.end < y.start
            ? y.start - x.end
            : y.end < x.start
              ? x.start - y.end
              : 0;
        if (
          distance !== undefined &&
          (gap === 0 || gap > distance || (ordered && x.end >= y.start))
        )
          continue;
        out.push({
          field: x.field,
          start: Math.min(x.start, y.start),
          end: Math.max(x.end, y.end),
        });
        bounded(out);
      }
    return out;
  }
  function spans(n: Node): Span[] {
    const cached = spanCache.get(n);
    if (cached) return cached;
    let out: Span[] = [];
    if (n.kind === "term") {
      const p = positions(n.term);
      for (const f of ["body", "title"] as const)
        if (field === "all" || field === f)
          for (const x of p[f]) {
            out.push({ field: f, start: x, end: x });
            bounded(out);
          }
    } else if (n.kind === "phrase") {
      for (const f of ["body", "title"] as const) {
        if (field !== "all" && field !== f) continue;
        const first = positions(n.terms[0])[f],
          remaining = n.terms.slice(1).map((t) => positions(t)[f]);
        for (const x of first) {
          if (++checks > 10000000)
            throw new QueryResourceError("Positional work limit exceeded");
          if (
            remaining.every((values, j) => {
              if (++checks > 10000000)
                throw new QueryResourceError("Positional work limit exceeded");
              let l = 0,
                r = values.length;
              const target = x + j + 1;
              while (l < r) {
                if (++checks > 10000000)
                  throw new QueryResourceError(
                    "Positional work limit exceeded",
                  );
                const m = (l + r) >>> 1;
                if (values[m] < target) l = m + 1;
                else r = m;
              }
              return values[l] === target;
            })
          ) {
            out.push({ field: f, start: x, end: x + n.terms.length - 1 });
            bounded(out);
          }
        }
      }
    } else if (n.kind === "near")
      out = combine(spans(n.left), spans(n.right), n.distance, n.ordered);
    else if (n.kind === "or")
      out = bounded([...spans(n.left), ...spans(n.right)]);
    else if (n.kind === "and") {
      if (matches(n.left) && matches(n.right)) {
        const a = spans(n.left),
          b = spans(n.right);
        out = !a.length ? b : !b.length ? a : combine(a, b);
      }
    } else if (n.kind === "except") out = matches(n.right) ? [] : spans(n.left);
    // Pure complements have no anchored occurrences and cannot satisfy proximity.
    spanCache.set(n, out);
    return out;
  }
  function matches(n: Node): boolean {
    const cached = truthCache.get(n);
    if (cached !== undefined) return cached;
    let result = false;
    if (n.kind === "all") result = true;
    else if (n.kind === "term") {
      const r = row(n.term),
        l = lists.get(n.term);
      result = r >= 0 && !!l && (field === "all" || l[field][r] > 0);
    } else if (n.kind === "phrase" || n.kind === "near")
      result = spans(n).length > 0;
    else if (n.kind === "not") result = !matches(n.child);
    else if (n.kind === "and") result = matches(n.left) && matches(n.right);
    else if (n.kind === "or") result = matches(n.left) || matches(n.right);
    else if (n.kind === "except") result = matches(n.left) && !matches(n.right);
    truthCache.set(n, result);
    return result;
  }
  return (doc: number) => {
    document = doc;
    positionCache.clear();
    spanCache.clear();
    truthCache.clear();
    return matches(ast);
  };
}
