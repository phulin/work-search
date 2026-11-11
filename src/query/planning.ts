import type { Node } from "./parser.js";
// A necessary coarse predicate, never a sufficient match predicate. OR must
// cover both sides; exclusions/negation cannot contribute false negatives.
export function candidatePlan(
  ast: Node,
  df: (term: string) => number,
  maxTerms = 4,
): { node: Node; terms: Set<string>; estimate: number } | undefined {
  const visit = (n: Node): ReturnType<typeof candidatePlan> => {
    if (n.kind === "term")
      return { node: n, terms: new Set([n.term]), estimate: df(n.term) };
    if (n.kind === "phrase")
      return n.terms
        .map((term) => visit({ kind: "term", term })!)
        .sort((a, b) => a.estimate - b.estimate)[0];
    if (n.kind === "empty" || n.kind === "all" || n.kind === "not") return;
    const a = visit(n.left),
      b = visit(n.right);
    if (n.kind === "except") return a;
    if (n.kind === "or") {
      if (!a || !b) return;
      const terms = new Set([...a.terms, ...b.terms]);
      if (terms.size > maxTerms) return;
      return {
        node: { kind: "or", left: a.node, right: b.node },
        terms,
        estimate: a.estimate + b.estimate,
      };
    }
    if (!a) return b;
    if (!b) return a;
    return a.estimate <= b.estimate ? a : b;
  };
  return visit(ast);
}
