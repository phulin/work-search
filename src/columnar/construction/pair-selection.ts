import type { Catalogue } from "./catalogue.js";
import type { PairStatisticsRun } from "./pair-statistics-runs.js";
import type { PairStatistics } from "./pair-statistics.js";
import type { Chunk } from "./runs.js";
import { pairPacketByteBound } from "../pair-packet.js";
type Selected = {
  key: number;
  a: number;
  b: number;
  df: number;
  occurrences: number;
  cost: number;
  utility: number;
};
class Heap {
  rows: Selected[] = [];
  worse(a: Selected, b: Selected) {
    return a.utility < b.utility || (a.utility === b.utility && a.key > b.key);
  }
  add(row: Selected) {
    const a = this.rows;
    if (a.length === 65536) {
      if (!this.worse(a[0], row)) return;
      a[0] = row;
      let i = 0;
      for (;;) {
        let j = i * 2 + 1;
        if (j >= a.length) break;
        if (j + 1 < a.length && this.worse(a[j + 1], a[j])) j++;
        if (!this.worse(a[j], a[i])) break;
        [a[i], a[j]] = [a[j], a[i]];
        i = j;
      }
    } else {
      a.push(row);
      let i = a.length - 1;
      while (i) {
        const j = (i - 1) >>> 1;
        if (!this.worse(a[i], a[j])) break;
        [a[i], a[j]] = [a[j], a[i]];
        i = j;
      }
    }
  }
}
/** Same corpus-only DF, occurrence and storage utility rules as the retained
 * constructor. Query strings are never inputs to accelerator selection. */
export async function selectPairs(
  catalogue: Catalogue,
  run: PairStatisticsRun,
  load: (ref: Chunk) => Promise<PairStatistics>,
  budget: number,
) {
  if (
    run.first !== 0 ||
    run.end !== catalogue.documents ||
    !Number.isSafeInteger(budget) ||
    budget < 0
  )
    throw Error("Invalid pair selection coverage/budget");
  const heap = new Heap(),
    terms = catalogue.pairTerms,
    width = terms.length;
  let previous = -1;
  for (const chunk of run.chunks) {
    const stats = await load(chunk);
    if (stats.first !== 0 || stats.end !== catalogue.documents)
      throw Error("Pair statistics document mismatch");
    for (let i = 0; i < stats.count; i++) {
      const key = stats.key(i);
      if (key <= previous) throw Error("Pair statistics key order mismatch");
      previous = key;
      const a = terms[Math.floor(key / width)],
        b = terms[key % width];
      if (!a || !b) throw Error("Pair statistics vocabulary mismatch");
      const df = stats.df(i),
        occurrences = stats.occurrences(i),
        anchor = Math.min(a.df, b.df),
        cost = pairPacketByteBound(df, occurrences);
      if (
        anchor < Math.min(1024, catalogue.documents / 8) ||
        df * 2 >= anchor ||
        cost > 8 * 1048576
      )
        continue;
      const saved =
        ((anchor - df) * catalogue.bodyTokens) / catalogue.documents +
        Math.max(
          0,
          Math.min(
            (a.bodyOccurrences ?? a.df) + (a.titleOccurrences ?? 0),
            (b.bodyOccurrences ?? b.df) + (b.titleOccurrences ?? 0),
          ) - occurrences,
        );
      heap.add({
        key,
        a: a.id,
        b: b.id,
        df,
        occurrences,
        cost,
        utility: (saved * occurrences) / cost,
      });
    }
  }
  const ranked = heap.rows.sort(
      (a, b) => b.utility - a.utility || a.key - b.key,
    ),
    pairs: Selected[] = [];
  let bytes = 0;
  for (const p of ranked)
    if (bytes + p.cost <= budget) {
      pairs.push(p);
      bytes += p.cost;
    }
  pairs.sort((a, b) => a.key - b.key);
  return {
    documents: catalogue.documents,
    terms,
    pairs,
    budget,
    estimatedBytes: bytes,
    selection:
      "Corpus DF/occurrence utility, exact lexical-ID ties, bounded 65536-entry heap; no query inputs",
  };
}
