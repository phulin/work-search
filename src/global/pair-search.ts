import { decodeTerm } from "./format.js";
import { parse } from "../query/parser.js";
import type { GlobalIndex, GlobalSearchOptions } from "./search.js";
import type { PageReader } from "./storage.js";
import type { PairFilter } from "./pairs.js";

/** Includes filter planning I/O in the same request diagnostics as exact search. */
export async function searchWithPairs(
  index: GlobalIndex,
  reader: PageReader,
  pairs: PairFilter | undefined,
  query: string,
  options: GlobalSearchOptions = {},
) {
  const start = performance.now();
  pairs?.reader.clearTrace();
  const dfs = new Map<string, number | undefined>();
  const candidateFilter = await pairs?.queryCandidates(
    parse(query),
    options.pairCosts
      ? {
          upper: (k) => options.pairCosts!.upper(k),
          df: (t) => {
            const local = options.pairCosts!.df(t);
            if (local !== undefined) return local;
            if (!dfs.has(t)) {
              const b = index.hot.lookup(t);
              dfs.set(t, b ? decodeTerm(b).df : undefined);
            }
            return dfs.get(t);
          },
        }
      : undefined,
  );
  const pairMs = performance.now() - start;
  const result = await index.search(reader, query, {
    ...options,
    candidateFilter,
  });
  const rounds = [
    ...(pairs?.reader.rounds ?? []),
    ...result.diagnostics.rounds,
  ];
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      milliseconds: performance.now() - start,
      pairMilliseconds: pairMs,
      pairCandidates: candidateFilter?.size,
      rounds,
      indexRounds: rounds.filter(
        (r) => r.stage !== "results-and-passages" && r.requests > 0,
      ).length,
      storageRounds: rounds.filter((r) => r.requests > 0).length,
      requests: rounds.reduce((s, r) => s + r.requests, 0),
      bytes: rounds.reduce((s, r) => s + r.bytes, 0),
    },
  };
}
