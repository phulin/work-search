import { queryTerms, type Node } from "../query/parser.js";
import type { Root } from "./format.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { Options } from "./search.js";
import { scoreCompleteCandidates } from "./frequency-scores.js";

/** Cold request/transfer priors select execution, never reject a document. */
export function estimateDocumentRanking(
  count: number,
  ast: Node,
  terms: ReadonlyMap<string, DirectoryTerm>,
  options: Options,
) {
  const limit = options.limit ?? 20;
  if (options.exactTotal || count <= Math.max(64, 3 * limit) || count > 262144)
    return;
  const names = queryTerms(ast, true),
    parts = names.flatMap((name) => {
      const term = terms.get(name)!;
      return [term.frequencies, ...(term.frequencyParts ?? [])].map((ref) => ({
        term,
        ref,
      }));
    }),
    bytes = parts.reduce((n, p) => n + p.ref[2], 0);
  if (!parts.length || !parts.every((p) => p.ref[2]) || bytes > 24 * 1048576)
    return;
  const expectedChecks = Math.min(count, 2 * limit + 6),
    savedWaitMs =
      Math.max(0, Math.ceil(count / 6) - Math.ceil(expectedChecks / 6)) * 60,
    readMs = bytes / 104857.6 + Math.ceil(parts.length / 6) * 60,
    decodeMs = names.reduce((n, name) => n + terms.get(name)!.df, 0) / 20000;
  if (readMs + decodeMs >= savedWaitMs) return;
  return { parts, bytes, expectedChecks, savedWaitMs, readMs, decodeMs };
}

/** Exact scores order verification, never establish a Boolean/phrase match.
 * Every unknown candidate remains reachable if too few documents verify. */
export async function rankDocumentCandidates(
  candidates: Iterable<number>,
  ast: Node,
  terms: ReadonlyMap<string, DirectoryTerm>,
  root: Root,
  reader: Reader,
  options: Options,
): Promise<{
  candidates: Iterable<number>;
  ranked?: { docs: Uint32Array; scores: Float64Array; order: Uint32Array };
}> {
  if (options.exactTotal) return { candidates };
  const selected: number[] = [];
  const iterator = candidates[Symbol.iterator]();
  for (;;) {
    // The alternate plan has a bounded numeric workspace. Exhausting it
    // resumes the original complete document stream, never truncates it.
    if (selected.length === 262144)
      return {
        candidates: {
          *[Symbol.iterator]() {
            yield* selected;
            yield* { [Symbol.iterator]: () => iterator };
          },
        },
      };
    const next = iterator.next();
    if (next.done) break;
    selected.push(next.value);
  }
  const docs = Uint32Array.from(selected);
  const estimate = estimateDocumentRanking(docs.length, ast, terms, options);
  if (!estimate) return { candidates: docs };
  const { parts, bytes, savedWaitMs, readMs, decodeMs } = estimate;
  reader.stats.documentRankingAlternative = {
    candidates: docs.length,
    bytes,
    savedWaitMs,
    readMs,
    decodeMs,
  };
  const scores = await scoreCompleteCandidates(
      docs,
      parts,
      root,
      reader,
      options,
    ),
    order = Uint32Array.from({ length: docs.length }, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a] || docs[a] - docs[b]);
  reader.stats.documentRankingCandidates = docs.length;
  reader.stats.documentRankingBytes = bytes;
  return { candidates: docs, ranked: { docs, scores, order } };
}
