import { queryTerms, type Node } from "../query/parser.js";
import { mandatoryPhrases } from "../columnar/pair-evidence.js";

/** A mandatory phrase bounds this query's score only when its distinct words
 * are exactly the scored vocabulary. All other matching conditions still need
 * the original evaluator; their truth never follows from the ranking record. */
export function filteredRankingPhrase(ast: Node) {
  if (ast.kind === "phrase") return;
  const scored = new Set(queryTerms(ast, true));
  return [...mandatoryPhrases(ast).values()]
    .filter(
      (words) =>
        words.length >= 2 &&
        words.length <= 5 &&
        new Set(words).size === scored.size &&
        words.every((w) => scored.has(w)),
    )
    .sort((a, b) => b.length - a.length)[0];
}
