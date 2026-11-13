import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { jsonLines } from "../../src/builder/jsonl.js";
import { tokenize } from "../../src/query/tokenize.js";
import { parse, queryTerms } from "../../src/query/parser.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { Reader } from "../../src/columnar/storage.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import { exhaustive } from "./exhaustive.js";
import { benchmarkToken } from "./token.js";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
const [dir, input, out] = process.argv.slice(2);
if (!out)
  throw Error("Usage: oracle-large.ts INDEX_DIR CORPUS.jsonl.gz OUTPUT.json");
while (
  !(await readFile(dir + "/root.json", "utf8").then(
    () => true,
    () => false,
  ))
)
  await new Promise((r) => setTimeout(r, 5000));
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  heldout = JSON.parse(
    await readFile("work/columnar-bench/heldout.json", "utf8").catch(async () =>
      JSON.stringify({
        queries: JSON.parse(
          await readFile("bench/columnar/query-contract.json", "utf8"),
        ).heldout,
      }),
    ),
  ),
  contracts = JSON.parse(
    await readFile("work/columnar-bench/contracts.json", "utf8").catch(
      async () =>
        JSON.stringify(
          JSON.parse(
            await readFile("bench/columnar/query-contract.json", "utf8"),
          ).contracts,
        ),
    ),
  );
const scenarios = [
  ...demoWorkload,
  ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
  ...heldout.queries,
  ...contracts.map((c: any) => ({
    ...c,
    oracle: undefined,
    options: { ...c.options, after: undefined },
    page: c.kind.includes("pagination") ? 1 : 0,
  })),
];
const names = [
    ...new Set<string>(
      scenarios.flatMap((s: any) => queryTerms(parse(s.q, s.options?.mode))),
    ),
  ],
  wordIndex = new Map(names.map((t, i) => [t, i])),
  objects = new OfflineObjects(dir, root, {
    url: "https://work-search-cws-upload.phulin.workers.dev",
    token: await benchmarkToken(),
  }),
  source = objects.source,
  terms = await new ColumnarIndex(root).terms(names, new Reader(root, source));
await objects.close();
const idf = names.map((t) =>
    Math.log(
      1 +
        (root.count - (terms.get(t)?.df ?? 0) + 0.5) /
          ((terms.get(t)?.df ?? 0) + 0.5),
    ),
  ),
  observedDf = new Uint32Array(names.length),
  bf = new Uint32Array(names.length),
  tf = new Uint32Array(names.length),
  b = new Float64Array(names.length),
  t = new Float64Array(names.length);
const plans = scenarios.map((s: any) => ({
  ...s,
  ast: parse(s.q, s.options?.mode),
  scoring: queryTerms(parse(s.q, s.options?.mode), true).map((n) =>
    wordIndex.get(n)!,
  ),
  ranked: [] as any[],
}));
let doc = 0,
  bodySum = 0,
  titleSum = 0;
const hash = createHash("sha256"),
  started = performance.now();
for await (const line of jsonLines(input)) {
  if (!line.trim()) continue;
  const d = JSON.parse(line);
  hash.update(JSON.stringify(d) + "\n");
  const body = tokenize(d.body),
    title = tokenize(d.title ?? "");
  bodySum += body.length;
  titleSum += title.length;
  bf.fill(0);
  tf.fill(0);
  b.fill(0);
  t.fill(0);
  for (const word of body) {
    const i = wordIndex.get(word);
    if (i !== undefined) bf[i]++;
  }
  for (const word of title) {
    const i = wordIndex.get(word);
    if (i !== undefined) tf[i]++;
  }
  for (let i = 0; i < names.length; i++) {
    if (bf[i] || tf[i]) observedDf[i]++;
    if (bf[i])
      b[i] =
        (idf[i] * (bf[i] * 2.2)) /
        (bf[i] + 1.2 * (0.25 + (0.75 * body.length) / (root.avgBody || 1)));
    if (tf[i])
      t[i] =
        (idf[i] * (tf[i] * 2.2)) /
        (tf[i] + 1.2 * (0.25 + (0.75 * title.length) / (root.avgTitle || 1)));
  }
  for (const p of plans) {
    const opts = p.options ?? {},
      field = opts.field ?? "all",
      boost = opts.titleBoost ?? 2,
      k = (opts.limit ?? 20) * ((p.page ?? 0) + 1),
      ranked = p.ranked;
    let score = 0;
    for (const i of p.scoring)
      score +=
        (field !== "title" ? b[i] : 0) + (field !== "body" ? boost * t[i] : 0);
    if (
      ranked.length === k &&
      (score < ranked[k - 1].score ||
        (score === ranked[k - 1].score && doc > ranked[k - 1].doc))
    )
      continue;
    if (
      p.ast.kind === "phrase" &&
      p.ast.terms.some((n: string) => {
        const i = wordIndex.get(n)!;
        return field === "body"
          ? !bf[i]
          : field === "title"
            ? !tf[i]
            : !bf[i] && !tf[i];
      })
    )
      continue;
    if (
      !exhaustive(
        p.ast,
        field === "all" ? [body, title] : field === "body" ? [body] : [title],
      )
    )
      continue;
    ranked.push({ id: d.id, doc, score, title: d.title, metadata: d.metadata });
    ranked.sort((a: any, b: any) => b.score - a.score || a.doc - b.doc);
    if (ranked.length > k) ranked.pop();
  }
  if (++doc % 10000 === 0)
    console.log(
      "large exhaustive oracle",
      doc,
      Math.round((performance.now() - started) / 1000),
    );
}
if (
  doc !== root.count ||
  hash.digest("hex") !== root.corpusHash ||
  bodySum / doc !== root.avgBody ||
  titleSum / doc !== root.avgTitle
)
  throw Error("Corpus/global statistic mismatch");
for (let i = 0; i < names.length; i++)
  if (observedDf[i] !== (terms.get(names[i])?.df ?? 0))
    throw Error("Independent DF mismatch " + names[i]);
await writeFile(
  out,
  JSON.stringify({
    generation: root.generation,
    corpusHash: root.corpusHash,
    count: doc,
    independentDfVerified: true,
    oracleMs: performance.now() - started,
    scenarios: plans.map((p: any) => {
      const limit = p.options?.limit ?? 20,
        start = (p.page ?? 0) * limit,
        last = p.ranked[start - 1];
      return {
        q: p.q,
        kind: p.kind,
        ...(last ? { cursorPredecessor: last } : {}),
        options: {
          ...p.options,
          ...(last ? { after: { score: last.score, doc: last.doc } } : {}),
        },
        oracle: p.ranked.slice(start, start + limit),
      };
    }),
  }),
);
