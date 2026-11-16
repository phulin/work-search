import type { PhraseExecution } from "./search.js";
import type { MembershipAnchor } from "./membership-anchor.js";
import { intersectCursors } from "./numeric-cursor.js";

/** Independent exact sources retain their own streaming windows. Their AST
 * masks are conservative supersets, so intersecting them preserves recall. */
export function combinePhraseExecution(
  a: PhraseExecution,
  b: PhraseExecution,
): PhraseExecution {
  const combined: PhraseExecution = {
    plans: [...a.plans, ...b.plans],
    covered: (words) => a.covered(words) || b.covered(words),
    evidence: (words, doc, field) =>
      a.evidence(words, doc, field) ?? b.evidence(words, doc, field),
    truth: (words, doc, field) =>
      a.truth(words, doc, field) ?? b.truth(words, doc, field),
    window: async (lo, hi) => {
      await Promise.all([a.window(lo, hi), b.window(lo, hi)]);
    },
    release: (lo) => {
      a.release(lo);
      b.release(lo);
    },
    get bufferBytes() {
      return a.bufferBytes + b.bufferBytes;
    },
    positionGuard: (ast, covered, field) => {
      const x = a.positionGuard(ast, covered, field),
        y = b.positionGuard(ast, covered, field);
      return (word, doc) => x(word, doc) && y(word, doc);
    },
    mask: (ast, field) => {
      const x = a.mask(ast, field),
        y = b.mask(ast, field);
      if (x.length !== y.length) throw Error("Phrase windows differ");
      return x.map((v, i) => Number(!!v && !!y[i]));
    },
    candidateAnchor: (ast, field) => {
      const x = a.candidateAnchor?.(ast, field),
        y = b.candidateAnchor?.(ast, field);
      if (!x && !y) return;
      const cursor = () =>
        x && y
          ? intersectCursors([x.cursor(), y.cursor()])
          : (x ?? y)!.cursor();
      const anchor: MembershipAnchor = {
        count: Math.min(x?.count ?? Infinity, y?.count ?? Infinity),
        bufferBytes: (x?.bufferBytes ?? 0) + (y?.bufferBytes ?? 0),
        values: function* () {
          const c = cursor();
          for (let doc = c.next(); doc !== Infinity; doc = c.next()) yield doc;
        },
        has: (doc) => (!x || x.has(doc)) && (!y || y.has(doc)),
        cursor,
        covered: combined.covered,
        evidence: combined.evidence,
      };
      return anchor;
    },
  };
  return combined;
}
