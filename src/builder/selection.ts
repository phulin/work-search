import { parse, queryTerms, simplify } from "../query/parser.js";
export interface Item {
  term: string;
  length: number;
}
// Greedy query-completion packages capture AND-query interactions; individual utility fills remaining space.
export function selectPostings(
  items: Item[],
  budget: number,
  strategy: "smallest" | "workload",
  workload: string[] = [],
): Set<string> {
  const chosen = new Set<string>(),
    sizes = new Map(items.map((x) => [x.term, x.length]));
  let left = budget;
  const queries = workload
    .map((q) => queryTerms(simplify(parse(q), (t) => sizes.has(t))))
    .filter((q) => q.length && q.every((t) => sizes.has(t)));
  if (strategy === "workload") {
    const packages = new Map<string, string[]>();
    for (const q of queries) packages.set([...q].sort().join(" "), q);
    while (packages.size) {
      let best: string | undefined,
        bestRatio = -1;
      for (const [key, q] of packages) {
        const missing = q.filter((t) => !chosen.has(t)),
          cost = missing.reduce((s, t) => s + sizes.get(t)!, 0);
        if (!cost || cost > left) continue;
        const future = new Set([...chosen, ...missing]);
        const gain = queries.filter(
          (x) =>
            !x.every((t) => chosen.has(t)) && x.every((t) => future.has(t)),
        ).length;
        if (gain / cost > bestRatio) {
          bestRatio = gain / cost;
          best = key;
        }
      }
      if (best === undefined) break;
      for (const t of packages.get(best)!) {
        if (!chosen.has(t)) {
          chosen.add(t);
          left -= sizes.get(t)!;
        }
      }
      packages.delete(best);
    }
  }
  const freq = new Map<string, number>();
  for (const q of queries)
    for (const t of q) freq.set(t, (freq.get(t) ?? 0) + 1);
  const ordered = [...items].sort((a, b) =>
    strategy === "workload"
      ? (freq.get(b.term) ?? 0) / b.length -
          (freq.get(a.term) ?? 0) / a.length ||
        a.length - b.length ||
        (a.term < b.term ? -1 : 1)
      : a.length - b.length || (a.term < b.term ? -1 : 1),
  );
  for (const x of ordered)
    if (!chosen.has(x.term) && x.length <= left) {
      chosen.add(x.term);
      left -= x.length;
    }
  return chosen;
}
