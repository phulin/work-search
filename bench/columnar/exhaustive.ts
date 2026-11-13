import type { Node } from "../../src/query/parser.js";
export type Span = [number, number];
// Independent exhaustive token-array evaluator, intentionally no index, pruning,
// packed decoder, or production positional matcher. Used only as an oracle.
export function exhaustive(ast: Node, fields: string[][]) {
  const term = (name: string, f: number): Span[] =>
    fields[f].flatMap((t, i) => (t === name ? [[i, i] as Span] : []));
  function spans(n: Node, f: number): Span[] {
    if (n.kind === "term") return term(n.term, f);
    if (n.kind === "phrase") {
      const ts = fields[f],
        out: Span[] = [];
      for (let i = 0; i + n.terms.length <= ts.length; i++)
        if (n.terms.every((t, j) => ts[i + j] === t))
          out.push([i, i + n.terms.length - 1]);
      return out;
    }
    if (n.kind === "or")
      return [...spans(n.left, f), ...spans(n.right, f)].sort(
        (a, b) => a[0] - b[0] || a[1] - b[1],
      );
    if (n.kind === "except") return truth(n.right) ? [] : spans(n.left, f);
    if (n.kind === "and") {
      if (!truth(n.left) || !truth(n.right)) return [];
      const a = spans(n.left, f),
        b = spans(n.right, f);
      if (
        !a.length &&
        !fields.some((_, g) => g !== f && spans(n.left, g).length)
      )
        return b;
      if (
        !b.length &&
        !fields.some((_, g) => g !== f && spans(n.right, g).length)
      )
        return a;
      return a.flatMap((x) =>
        b.map((y) => [Math.min(x[0], y[0]), Math.max(x[1], y[1])] as Span),
      );
    }
    if (n.kind === "near") {
      const a = spans(n.left, f),
        b = spans(n.right, f),
        out: Span[] = [];
      for (const x of a)
        for (const y of b) {
          if (y[0] > x[1] && y[0] - x[1] <= n.distance) out.push([x[0], y[1]]);
          if (!n.ordered && x[0] > y[1] && x[0] - y[1] <= n.distance)
            out.push([y[0], x[1]]);
        }
      return out;
    }
    return [];
  }
  function truth(n: Node): boolean {
    if (n.kind === "empty") return false;
    if (n.kind === "all") return true;
    if (n.kind === "term") return fields.some((ts) => ts.includes(n.term));
    if (n.kind === "phrase")
      return fields.some((ts) =>
        ts.some((_, i) => n.terms.every((t, j) => ts[i + j] === t)),
      );
    if (n.kind === "not") return !truth(n.child);
    if (n.kind === "and") return truth(n.left) && truth(n.right);
    if (n.kind === "or") return truth(n.left) || truth(n.right);
    if (n.kind === "except") return truth(n.left) && !truth(n.right);
    if (n.kind !== "near") throw Error("Unknown oracle AST");
    return fields.some((_, f) => {
      const a = spans(n.left, f),
        b = spans(n.right, f);
      for (const x of a)
        for (const y of b)
          if (
            (y[0] > x[1] && y[0] - x[1] <= n.distance) ||
            (!n.ordered && x[0] > y[1] && x[0] - y[1] <= n.distance)
          )
            return true;
      return false;
    });
  }
  return truth(ast);
}
