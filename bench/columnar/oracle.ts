import { readFile, writeFile, mkdir } from "node:fs/promises";
import { BinaryIndex } from "../../src/format/index.js";
import { parse, queryTerms } from "../../src/query/parser.js";
import { tokenize } from "../../src/query/tokenize.js";
import { jsonLines } from "../../src/builder/jsonl.js";
import { exhaustive } from "./exhaustive.js";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
const existing = [...demoWorkload, ...globalQueries],
  data = JSON.parse(
    await readFile("bench/results/flp100k-queries.json", "utf8"),
  );
const heldout = (data.eval ?? data.test ?? data.queries).filter(
  (q: any) => !existing.some((p) => p.q === q.q),
);
const queries = [...new Set<string>(heldout.map((q: any) => q.kind))].flatMap(
  (kind) => heldout.filter((q: any) => q.kind === kind).slice(-4),
);
queries.push(
  ...[
    '"the and of the"',
    '"in the"',
    '"court court court court"',
    '"and on that advice"',
    'NOT "summary judgment"',
    'court NOT "personal jurisdiction"',
    'NOT NOT "clear and convincing evidence"',
    '(jurisdiction OR "summary judgment") AND NOT "res ipsa loquitur"',
    '"summary judgment" /10 evidence',
    "(motion OR court) +5 jurisdiction",
    'court OR the OR of OR "and"',
    "(the OR of) AND (court OR judgment)",
    '"ＪＵＲＩＳＤＩＣＴＩＯＮ"',
    '"judgment summary"',
    '"and and"',
    '"unfindable word zero"',
  ].map((q) => ({ q, kind: "heldout-adversarial" })),
);
const index = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  ),
  oracle: Record<string, any[]> = {};
const plans = queries.map((q: any) => ({
  q: q.q,
  ast: parse(q.q),
  terms: queryTerms(parse(q.q), true),
}));
for (const p of plans) oracle[p.q] = [];
let doc = 0;
for await (const line of jsonLines("bench/generated/flp-100000/corpus.jsonl")) {
  if (!line.trim()) continue;
  const d = JSON.parse(line),
    body = tokenize(d.body),
    title = tokenize(d.title ?? "");
  const freq = (ts: string[]) => {
      const counts = new Map<string, number>();
      for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
      return counts;
    },
    bf = freq(body),
    tf = freq(title);
  for (const p of plans) {
    const out = oracle[p.q];
    const contribution = (
      term: string,
      f: number,
      len: number,
      avg: number,
    ) => {
      if (!f) return 0;
      const df = index.lookup(term)?.df ?? 0;
      return (
        (Math.log(1 + (index.count - df + 0.5) / (df + 0.5)) * (f * 2.2)) /
        (f + 1.2 * (0.25 + (0.75 * len) / (avg || 1)))
      );
    };
    let score = 0;
    for (const t of p.terms)
      score +=
        contribution(t, bf.get(t) ?? 0, body.length, index.avgBody) +
        2 * contribution(t, tf.get(t) ?? 0, title.length, index.avgTitle);
    if (
      out.length === 20 &&
      (score < out[19].score || (score === out[19].score && doc > out[19].doc))
    )
      continue;
    if (!exhaustive(p.ast, [body, title])) continue;
    out.push({ id: d.id, title: d.title, metadata: d.metadata, score, doc });
    out.sort((a, b) => b.score - a.score || a.doc - b.doc);
    if (out.length > 20) out.pop();
  }
  if (++doc % 10000 === 0) console.log("exhaustive oracle documents", doc);
}
await mkdir("work/columnar-bench", { recursive: true });
await writeFile(
  "work/columnar-bench/heldout.json",
  JSON.stringify({ queries, oracle }, null, 2),
);
