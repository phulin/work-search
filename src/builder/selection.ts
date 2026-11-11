import {
  parse,
  queryTerms,
  simplify,
  positionalTerms,
} from "../query/parser.js";
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

// Joint packages represent all streams needed by a complete query. Duplicate
// workload lines retain their weight; selection is deterministic at equal gain.
export function selectStreams(
  items: (Item & { positionLength: number })[],
  budget: number,
  workload: string[],
): { frequencies: Set<string>; positions: Set<string> } {
  const byTerm = new Map(items.map((i) => [i.term, i]));
  const sizes = new Map<string, number>();
  for (const i of items) {
    sizes.set("f:" + i.term, i.length);
    sizes.set("p:" + i.term, i.positionLength);
  }
  const queries = workload
    .map((q) => {
      const ast = simplify(parse(q), (t) => byTerm.has(t));
      return [
        ...queryTerms(ast).map((t) => "f:" + t),
        ...[...positionalTerms(ast)].map((t) => "p:" + t),
      ];
    })
    .filter((q) => q.length);
  const chosen = new Set<string>();
  let left = budget;
  const packages = new Map<string, string[]>();
  for (const q of queries) packages.set([...q].sort().join("\u0000"), q);
  while (packages.size) {
    let best: string | undefined,
      ratio = -1;
    for (const [key, q] of packages) {
      const missing = q.filter((t) => !chosen.has(t)),
        cost = missing.reduce((s, t) => s + sizes.get(t)!, 0);
      if (!cost || cost > left) continue;
      const future = new Set([...chosen, ...missing]);
      const completions = queries.filter(
        (q) => !q.every((t) => chosen.has(t)) && q.every((t) => future.has(t)),
      ).length;
      // Completing queries dominates; avoided individual stream reads break
      // ties and reward partial progress when a complete query cannot fit.
      const saved = queries.reduce(
        (s, q) => s + q.filter((t) => !chosen.has(t) && future.has(t)).length,
        0,
      );
      const gain = (completions + saved * 0.05) / cost;
      if (gain > ratio) {
        ratio = gain;
        best = key;
      }
    }
    if (best === undefined) break;
    for (const t of packages.get(best)!)
      if (!chosen.has(t)) {
        chosen.add(t);
        left -= sizes.get(t)!;
      }
    packages.delete(best);
  }
  const frequency = new Map<string, number>();
  for (const q of queries)
    for (const t of q) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  for (const [t, size] of [...sizes].sort(
    (a, b) =>
      (frequency.get(b[0]) ?? 0) / b[1] - (frequency.get(a[0]) ?? 0) / a[1] ||
      a[1] - b[1] ||
      (a[0] < b[0] ? -1 : 1),
  ))
    if (!chosen.has(t) && size <= left) {
      chosen.add(t);
      left -= size;
    }
  return {
    frequencies: new Set(
      [...chosen].filter((t) => t.startsWith("f:")).map((t) => t.slice(2)),
    ),
    positions: new Set(
      [...chosen].filter((t) => t.startsWith("p:")).map((t) => t.slice(2)),
    ),
  };
}
