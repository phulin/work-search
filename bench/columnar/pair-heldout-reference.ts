import { readFile, writeFile } from "node:fs/promises";
import { DocumentPackage } from "../../src/columnar/document-package.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { Reader } from "../../src/columnar/storage.js";
import { LocalObjects } from "./local-storage.js";
import { tokenizerFor } from "../../src/query/analysis.js";
import type { Root } from "../../src/columnar/format.js";

const [dir, out] = process.argv.slice(2),
  store = process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data";
if (!dir || !out)
  throw Error("Usage: pair-heldout-reference.ts INDEX_DIR OUTPUT.json");
const root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8"));
if (root.count !== 1000000)
  throw Error("Experiments require the existing 1M generation");
const tokenize = tokenizerFor(root.analysis),
  definitions = [
    { q: '"burden of proving"', kind: "fresh-pair-phrase" },
    { q: '"in the absence of"', kind: "fresh-common-phrase" },
    { q: '"on the other hand"', kind: "fresh-common-phrase" },
    { q: '"there is no evidence"', kind: "fresh-common-phrase" },
    { q: '"the an of"', kind: "fresh-zero-phrase" },
    { q: '"notwithstanding the foregoing"', kind: "fresh-pair-phrase" },
    {
      q: '"in the absence of"',
      kind: "fresh-title-phrase",
      options: { field: "title" },
    },
    {
      q: '"burden of proving"',
      kind: "fresh-body-phrase",
      options: { field: "body" },
    },
  ],
  directory = new TermDirectory(
    await readFile(dir + "/directory.bin"),
    root.count,
  ),
  reader = new Reader(root, new LocalObjects(root, store)),
  names = [...new Set(definitions.flatMap((d) => tokenize(d.q)))],
  terms = await directory.lookup(names, reader),
  observed = new Uint32Array(names.length),
  index = new Map(names.map((name, i) => [name, i]));
const queries = definitions.map((d) => ({
  ...d,
  words: tokenize(d.q),
  ids: tokenize(d.q).map((word) => terms.get(word)?.id ?? -1),
  hits: [] as { doc: number; score: number }[],
  total: 0,
}));
function lower(a: Uint32Array, x: number) {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function phrase(tokens: Uint32Array, words: number[]) {
  outer: for (let p = 0; p + words.length <= tokens.length; p++) {
    for (let i = 0; i < words.length; i++)
      if (tokens[p + i] !== words[i]) continue outer;
    return true;
  }
  return false;
}
function contribution(tf: number, df: number, len: number, avg: number) {
  return tf
    ? (Math.log(1 + (root.count - df + 0.5) / (df + 0.5)) * (tf * 2.2)) /
        (tf + 1.2 * (0.25 + (0.75 * len) / (avg || 1)))
    : 0;
}
const raw = await readFile(dir + "/documents.bin"),
  groups = raw.readUInt32LE(8),
  started = performance.now();
let documents = 0;
for (let group = 0; group < groups; group++) {
  const digest = raw.subarray(32 + group * 48, 64 + group * 48).toString("hex"),
    bytes = await readFile(`${store}/objects/${digest}/plan-0.bin`);
  for (let offset = 0; offset < bytes.length;) {
    const doc = bytes.readUInt32LE(offset + 4),
      length =
        bytes.readUInt32LE(offset + 56) + bytes.readUInt32LE(offset + 60),
      pkg = new DocumentPackage(bytes.subarray(offset, offset + length), doc),
      f = pkg.frequencies(),
      frequencies = new Uint32Array(names.length * 2);
    for (let i = 0; i < names.length; i++) {
      const term = terms.get(names[i]);
      if (!term) continue;
      const at = lower(f.ids, term.id);
      if (f.ids[at] === term.id) {
        frequencies[i * 2] = f.body[at];
        frequencies[i * 2 + 1] = f.title[at];
        observed[i]++;
      }
    }
    for (const query of queries) {
      if (query.ids.includes(-1)) continue;
      const field = query.options?.field ?? "all";
      let body = field !== "title",
        title = field !== "body";
      for (const word of query.words) {
        const at = index.get(word)! * 2;
        body &&= frequencies[at] > 0;
        title &&= frequencies[at + 1] > 0;
      }
      if (
        !(body && phrase(pkg.tokens(0), query.ids)) &&
        !(title && phrase(pkg.tokens(1), query.ids))
      )
        continue;
      let score = 0;
      for (const word of [...new Set(query.words)]) {
        const at = index.get(word)! * 2,
          term = terms.get(word)!;
        score +=
          (field !== "title"
            ? contribution(
                frequencies[at],
                term.df,
                pkg.bodyLength,
                root.avgBody,
              )
            : 0) +
          (field !== "body"
            ? 2 *
              contribution(
                frequencies[at + 1],
                term.df,
                pkg.titleLength,
                root.avgTitle,
              )
            : 0);
      }
      query.total++;
      query.hits.push({ doc, score });
      query.hits.sort((a, b) => b.score - a.score || a.doc - b.doc);
      if (query.hits.length > 20) query.hits.pop();
    }
    documents++;
    offset += length;
  }
  if (group % 500 === 0)
    console.log("Reference scanned", documents, "documents");
}
if (documents !== root.count) throw Error("Incomplete exhaustive reference");
names.forEach((name, i) => {
  if (observed[i] !== (terms.get(name)?.df ?? 0))
    throw Error("Independent heldout DF mismatch: " + name);
});
const scenarios = [];
for (const query of queries) {
  const oracle = [];
  for (const hit of query.hits) {
    const data = await import("../../src/columnar/document-directory.js"),
      locator = new data.DocumentDirectory(raw).lookup(hit.doc),
      file = await readFile(`${store}/objects/${locator.key}`),
      pkg = new DocumentPackage(
        file.subarray(locator.offset, locator.offset + locator.length),
        hit.doc,
      ),
      display = await pkg.display();
    oracle.push({
      ...hit,
      id: display.id,
      title: display.title,
      metadata: display.metadata,
    });
  }
  scenarios.push({
    q: query.q,
    kind: query.kind,
    options: query.options ?? {},
    oracle,
    total: query.total,
    assertPhraseSnippet: true,
  });
}
await writeFile(
  out,
  JSON.stringify(
    {
      generation: root.generation,
      corpusHash: root.corpusHash,
      analysis: root.analysis,
      count: root.count,
      reference:
        "Exhaustive 1M numeric-token scan; independent phrase matcher, frequency verification, score computation and ranking; no pair or pruning code",
      elapsedMs: performance.now() - started,
      scenarios,
    },
    null,
    2,
  ),
);
console.log(
  "Saved heldout reference",
  out,
  scenarios.map((s) => ({ q: s.q, field: s.options, total: s.total })),
);
