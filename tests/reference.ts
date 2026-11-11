import { tokenize, type Document } from "../src/query/tokenize.js";
// Deliberately scans token arrays; does not use postings, intersections, BM25 helper, or heap.
export function reference(
  docs: Document[],
  q: string,
  mode: "and" | "or" = "and",
  boost = 2,
) {
  const terms = [...new Set(tokenize(q))];
  if (!terms.length) return [];
  const records = docs.map((d) => ({
    d,
    b: tokenize(d.body),
    t: tokenize(d.title ?? ""),
  }));
  const avgB = records.reduce((s, r) => s + r.b.length, 0) / docs.length,
    avgT = records.reduce((s, r) => s + r.t.length, 0) / docs.length;
  const df = terms.map(
    (t) => records.filter((r) => r.b.includes(t) || r.t.includes(t)).length,
  );
  const score = (tf: number, f: number, len: number, avg: number) =>
    tf
      ? (Math.log((docs.length + 1) / (f + 0.5)) * tf * 2.2) /
        (tf + 1.2 * (0.25 + (0.75 * len) / (avg || 1)))
      : 0;
  return records
    .map((r, doc) => {
      const matches = terms.map((t) => r.b.includes(t) || r.t.includes(t));
      return {
        id: r.d.id,
        doc,
        match: mode === "and" ? matches.every(Boolean) : matches.some(Boolean),
        score: terms.reduce(
          (s, t, j) =>
            s +
            score(r.b.filter((x) => x === t).length, df[j], r.b.length, avgB) +
            boost *
              score(r.t.filter((x) => x === t).length, df[j], r.t.length, avgT),
          0,
        ),
      };
    })
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score || a.doc - b.doc)
    .map(({ id, score }) => ({ id, score }));
}
