import { readFile, writeFile, mkdir } from "node:fs/promises";
import { jsonLines } from "../src/builder/jsonl.js";
import { createHash } from "node:crypto";
import { tokenize } from "../src/query/tokenize.js";
const root = process.env.FLP_ROOT ?? "bench/generated/flp";
await mkdir(root, { recursive: true });
const lengths: number[] = [],
  titles: number[] = [],
  courts: Record<string, number> = {},
  decades: Record<string, number> = {};
const examples: { id: string; tokens: string[] }[] = [];
for await (const line of jsonLines(root + "/corpus.jsonl")) {
  const d = JSON.parse(line),
    words = tokenize(d.body);
  lengths.push(words.length);
  titles.push(tokenize(d.title ?? "").length);
  courts[d.metadata.court_type ?? "unknown"] =
    (courts[d.metadata.court_type ?? "unknown"] ?? 0) + 1;
  const decade = d.metadata.date_filed
    ? d.metadata.date_filed.slice(0, 3) + "0"
    : "unknown";
  decades[decade] = (decades[decade] ?? 0) + 1;
  if (examples.length < 100) examples.push({ id: d.id, tokens: words });
}
const atom = (s: string) =>
  ["and", "or", "not", "except", "pre"].includes(s) ? JSON.stringify(s) : s;
const hash = (s: string) =>
  createHash("sha256")
    .update("flp-query-split-20261111:" + s)
    .digest("hex");
const terms = [
  "summary judgment",
  "qualified immunity",
  "due process",
  "probable cause",
  "reasonable suspicion",
  "ineffective assistance",
  "habeas corpus",
  "res judicata",
  "collateral estoppel",
  "statute limitations",
  "breach contract",
  "fiduciary duty",
  "personal jurisdiction",
  "subject matter jurisdiction",
  "strict scrutiny",
  "equal protection",
  "first amendment",
  "fourth amendment",
  "federal arbitration",
  "sovereign immunity",
  "punitive damages",
  "attorney fees",
  "standard review",
  "abuse discretion",
  "burden proof",
  "genuine dispute",
  "material fact",
  "criminal conviction",
  "plea agreement",
  "jury instruction",
  "expert testimony",
  "negligent misrepresentation",
  "intentional infliction",
  "employment discrimination",
  "wrongful termination",
  "public policy",
  "fair use",
  "copyright infringement",
  "trade secret",
  "antitrust injury",
  "administrative exhaustion",
  "excessive force",
  "search warrant",
  "unreasonable search",
  "reasonable doubt",
  "preliminary injunction",
  "irreparable harm",
  "class certification",
  "mootness standing",
  "removal jurisdiction",
  "arbitrary capricious",
  "substantial evidence",
  "contract interpretation",
  "plain meaning",
  "constitutional violation",
  "prison conditions",
  "medical malpractice",
  "proximate cause",
  "contributory negligence",
  "strict liability",
  "unjust enrichment",
  "specific performance",
  "double jeopardy",
  "ex post facto",
];
type Query = { q: string; kind: string; origin: string; document?: string };
const all: Query[] = [];
for (const t of terms) {
  const w = t.split(" ");
  all.push(
    { q: t, kind: "plain", origin: "hand-authored legal terms" },
    { q: `"${t}"`, kind: "phrase", origin: "hand-authored legal phrase" },
    {
      q: `${w[0]} /${[5, 25, 75][parseInt(hash(t).slice(0, 2), 16) % 3]} ${w.slice(1).join(" ")}`,
      kind: "proximity",
      origin: "hand-authored legal connector",
    },
    {
      q: `(${w[0]} OR ${w[w.length - 1]}) AND court`,
      kind: "boolean",
      origin: "hand-authored Boolean stress query",
    },
  );
}
for (const e of examples) {
  if (e.tokens.length < 8) continue;
  const start = parseInt(hash(e.id).slice(0, 8), 16) % (e.tokens.length - 5);
  const w = e.tokens.slice(start, start + 4);
  all.push(
    {
      q: w.slice(0, 2).map(atom).join(" "),
      kind: "plain",
      origin: "corpus-derived terms",
      document: e.id,
    },
    {
      q: `"${w.join(" ")}"`,
      kind: "phrase",
      origin: "corpus-derived phrase",
      document: e.id,
    },
    {
      q: `${atom(w[0])} /5 ${atom(w[3])}`,
      kind: "proximity",
      origin: "corpus-derived connector",
      document: e.id,
    },
    {
      q: `(${atom(w[0])} OR ${atom(w[1])}) AND ${atom(w[3])}`,
      kind: "boolean",
      origin: "corpus-derived Boolean query",
      document: e.id,
    },
  );
}
const unique = [...new Map(all.map((q) => [q.q, q])).values()];
const train: Query[] = [],
  test: Query[] = [];
for (const kind of ["plain", "phrase", "proximity", "boolean"]) {
  const pool = unique
    .filter((q) => q.kind === kind)
    .sort((a, b) => hash(a.q).localeCompare(hash(b.q)));
  train.push(...pool.slice(0, 16));
  test.push(...pool.slice(16, 56));
}
if (
  test.length !== 160 ||
  new Set(train.map((q) => q.q)).size !== 64 ||
  test.some((q) => train.some((t) => t.q === q.q))
)
  throw Error("Invalid workload split");
const stats = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    min: values[0],
    p50: values[Math.ceil(values.length * 0.5) - 1],
    p95: values[Math.ceil(values.length * 0.95) - 1],
    max: values[values.length - 1],
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    total: values.reduce((s, v) => s + v, 0),
  };
};
await writeFile(
  root + "/corpus-stats.json",
  JSON.stringify(
    {
      documents: lengths.length,
      bodyTokens: stats(lengths),
      titleTokens: stats(titles),
      courtTypes: courts,
      decades,
    },
    null,
    2,
  ),
);
if (process.env.FLP_QUERY_SOURCE) {
  const frozen = JSON.parse(
    await readFile(process.env.FLP_QUERY_SOURCE, "utf8"),
  );
  await writeFile(root + "/queries.json", JSON.stringify(frozen, null, 2));
  await writeFile(
    root + "/training.txt",
    frozen.train.map((q: { q: string }) => q.q).join("\n"),
  );
} else {
  await writeFile(
    root + "/queries.json",
    JSON.stringify(
      {
        seed: 20261111,
        description:
          "Artificial legal stress workload, not user query logs; 64 training and 160 disjoint evaluation strings, balanced across four query types. Corpus-derived queries are biased toward having matches.",
        train,
        test,
      },
      null,
      2,
    ),
  );
  await writeFile(root + "/training.txt", train.map((q) => q.q).join("\n"));
}
