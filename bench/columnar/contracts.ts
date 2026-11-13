import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../../src/format/index.js";
import { jsonLines } from "../../src/builder/jsonl.js";
import { tokenize } from "../../src/query/tokenize.js";
import { parse, queryTerms } from "../../src/query/parser.js";
import { exhaustive } from "./exhaustive.js";
import type { Options } from "../../src/columnar/search.js";
const index = new BinaryIndex(
  await readFile("bench/generated/flp-100000/source/bundle.bin"),
);
const definitions: {
  q: string;
  kind: string;
  options: Options;
  page?: number;
}[] = [
  { q: "court", kind: "field-body", options: { field: "body" } },
  { q: "court", kind: "field-title", options: { field: "title" } },
  {
    q: "court",
    kind: "tie-title-zero",
    options: { field: "title", titleBoost: 0 },
  },
  { q: "court", kind: "boost-20", options: { titleBoost: 20 } },
  { q: "court", kind: "boost-arbitrary", options: { titleBoost: 3.25 } },
  { q: "summary OR judgment", kind: "mode-or", options: { mode: "or" } },
  {
    q: '"clear and convincing evidence"',
    kind: "phrase-title",
    options: { field: "title" },
  },
  { q: '"in the"', kind: "common-phrase-body", options: { field: "body" } },
  { q: "motion /5 ten", kind: "proximity-body", options: { field: "body" } },
  { q: "court", kind: "pagination", options: {}, page: 1 },
  { q: '"summary judgment"', kind: "phrase-pagination", options: {}, page: 1 },
  { q: "jurisdiction", kind: "large-page", options: { limit: 100 } },
];
const contracts = definitions.map((c, i) => ({
  ...c,
  id: "contract-" + i,
  ast: parse(c.q, c.options.mode),
  terms: queryTerms(parse(c.q, c.options.mode), true),
  results: [] as any[],
}));
let doc = 0;
for await (const line of jsonLines("bench/generated/flp-100000/corpus.jsonl")) {
  if (!line.trim()) continue;
  const d = JSON.parse(line),
    body = tokenize(d.body),
    title = tokenize(d.title ?? ""),
    bf = new Map<string, number>(),
    tf = new Map<string, number>();
  for (const t of body) bf.set(t, (bf.get(t) ?? 0) + 1);
  for (const t of title) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const c of contracts) {
    const opts = c.options,
      field = opts.field ?? "all",
      boost = opts.titleBoost ?? 2,
      k = (opts.limit ?? 20) * ((c.page ?? 0) + 1),
      out = c.results;
    const contribution = (t: string, f: number, len: number, avg: number) =>
      f
        ? (Math.log(
            1 +
              (index.count - (index.lookup(t)?.df ?? 0) + 0.5) /
                ((index.lookup(t)?.df ?? 0) + 0.5),
          ) *
            (f * 2.2)) /
          (f + 1.2 * (0.25 + (0.75 * len) / (avg || 1)))
        : 0;
    let score = 0;
    for (const t of c.terms)
      score +=
        (field !== "title"
          ? contribution(t, bf.get(t) ?? 0, body.length, index.avgBody)
          : 0) +
        (field !== "body"
          ? boost *
            contribution(t, tf.get(t) ?? 0, title.length, index.avgTitle)
          : 0);
    if (
      out.length === k &&
      (score < out[k - 1].score ||
        (score === out[k - 1].score && doc > out[k - 1].doc))
    )
      continue;
    if (
      !exhaustive(
        c.ast,
        field === "all" ? [body, title] : field === "body" ? [body] : [title],
      )
    )
      continue;
    out.push({ id: d.id, title: d.title, metadata: d.metadata, score, doc });
    out.sort((a, b) => b.score - a.score || a.doc - b.doc);
    if (out.length > k) out.pop();
  }
  if (++doc % 10000 === 0) console.log("contract oracle", doc);
}
await writeFile(
  "work/columnar-bench/contracts.json",
  JSON.stringify(
    contracts.map((c) => {
      const limit = c.options.limit ?? 20,
        start = (c.page ?? 0) * limit,
        prior = c.results[start - 1];
      return {
        id: c.id,
        q: c.q,
        kind: c.kind,
        options: {
          ...c.options,
          ...(prior ? { after: { doc: prior.doc, score: prior.score } } : {}),
        },
        oracle: c.results.slice(start, start + limit),
      };
    }),
  ),
);
