import type { Node } from "../query/parser.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Root } from "./format.js";
import type { Reader } from "./storage.js";
import { savedWork, type FilterAlternative } from "./membership-anchor.js";
import { readAnchorDocuments } from "./packet-execution.js";
import {
  arrayCursor,
  intersectCursors,
  unionCursors,
  type NumericCursor,
} from "./numeric-cursor.js";

type Tree =
  | { kind: "term"; word: string; df: number }
  | { kind: "and" | "or"; left: Tree; right: Tree; df: number };
export interface TermFilterPlan {
  tree: Tree;
  names: string[];
  bytes: number;
  postings: number;
}
/** Build conservative Boolean evidence from cheap complete term lists. Unknown
 * is the universe: AND may use either side, OR needs both, NOT never subtracts
 * a superset. Price the surviving tree before starting any optional reads. */
export function planTermFilter(
  ast: Node,
  terms: ReadonlyMap<string, DirectoryTerm>,
  root: Root,
  alternative: FilterAlternative | undefined,
  candidates: number,
  proved: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
  documentBytes: number,
  exactTotal: boolean,
): TermFilterPlan | undefined {
  if (!alternative || alternative.kind !== "blocks" || candidates <= 128)
    return;
  const prices = new WeakMap<Tree, { gain: number; work: number }>();
  const info = (tree: Tree) => {
    const names = new Set<string>();
    const visit = (n: Tree): void => {
      if (n.kind === "term") names.add(n.word);
      else {
        visit(n.left);
        visit(n.right);
      }
    };
    visit(tree);
    let bytes = 0,
      postings = 0,
      gets = 0;
    for (const name of names) {
      const t = terms.get(name)!;
      bytes +=
        t.frequencies[2] +
        (t.frequencyParts ?? []).reduce((n, r) => n + r[2], 0);
      postings += t.df;
      gets += 1 + (t.frequencyParts?.length ?? 0);
    }
    return { names: [...names], bytes, postings, gets };
  };
  const fits = (tree: Tree) => {
    const plan = info(tree);
    return plan.bytes <= 1048576 && plan.postings * 28 <= 4 * 1048576;
  };
  const price = (tree: Tree) => {
    const old = prices.get(tree);
    if (old) return old;
    const plan = info(tree),
      expected = Math.min(candidates, (candidates * tree.df) / root.count),
      gain = savedWork(
        { ...alternative, expectedCandidates: candidates },
        expected,
        root.count,
        documentBytes,
        exactTotal,
      ),
      work =
        plan.bytes + plan.postings * 28 + Math.ceil(plan.gets / 6) * 262144,
      result = { gain, work };
    prices.set(tree, result);
    return result;
  };
  const term = (word: string): Tree | undefined => {
    if (proved.has(word) || excluded.has(word)) return;
    const t = terms.get(word);
    if (!t || !t.frequencies[2] || t.df > 50000) return;
    const tree: Tree = { kind: "term", word, df: t.df };
    return fits(tree) ? tree : undefined;
  };
  const visit = (n: Node): Tree | undefined => {
    if (n.kind === "term") return term(n.term);
    if (n.kind === "phrase")
      return n.terms
        .map(term)
        .filter((t): t is Tree => !!t)
        .sort((a, b) => a.df - b.df)[0];
    if (!("left" in n)) return;
    const left = visit(n.left);
    if (n.kind === "except") return left;
    const right = visit(n.right);
    if (n.kind === "or") {
      if (!left || !right) return;
      const tree: Tree = {
        kind: "or",
        left,
        right,
        df: Math.min(root.count, left.df + right.df),
      };
      return fits(tree) ? tree : undefined;
    }
    if (!left) return right;
    if (!right) return left;
    const tree: Tree = {
      kind: "and",
      left,
      right,
      df: Math.min(left.df, right.df),
    };
    // Either AND side is a valid conservative filter. Do not add another large
    // complete list when its extra decoding erases the estimated savings.
    // OR still requires both sides, and is never reduced this way.
    const choices = fits(tree) ? [tree, left, right] : [left, right];
    return choices.sort((a, b) => {
      const x = price(a),
        y = price(b);
      return y.gain - y.work - (x.gain - x.work) || a.df - b.df;
    })[0];
  };
  const tree = visit(ast);
  if (!tree) return;
  const plan = info(tree),
    { gain, work } = price(tree);
  return gain > work ? { tree, ...plan } : undefined;
}

export async function readTermFilter(
  plan: TermFilterPlan,
  terms: Map<string, DirectoryTerm>,
  root: Root,
  reader: Reader,
  field: "all" | "body" | "title",
) {
  reader.stats.booleanTermFilterWaves++;
  reader.stats.booleanTermFilterTerms += plan.names.length;
  const lists = new Map(
    await Promise.all(
      plan.names.map(
        async (name) =>
          [
            name,
            await readAnchorDocuments([name], terms, reader, field, root),
          ] as const,
      ),
    ),
  );
  reader.stats.candidateTermPostingsDecoded += plan.postings;
  const compile = (n: Tree): NumericCursor =>
    n.kind === "term"
      ? arrayCursor(lists.get(n.word)!)
      : n.kind === "or"
        ? unionCursors(compile(n.left), compile(n.right))
        : intersectCursors([compile(n.left), compile(n.right)]);
  const cursor = compile(plan.tree),
    docs = new Uint32Array(plan.tree.df);
  let count = 0;
  for (let doc = cursor.next(); doc !== Infinity; doc = cursor.next()) {
    if (count === docs.length)
      throw Error("Term filter exceeded conservative DF bound");
    docs[count++] = doc;
  }
  reader.stats.peakActiveBufferBytes = Math.max(
    reader.stats.peakActiveBufferBytes,
    reader.stats.anchorBufferBytes +
      plan.bytes +
      plan.postings * 32 +
      docs.byteLength,
  );
  return docs.subarray(0, count);
}
