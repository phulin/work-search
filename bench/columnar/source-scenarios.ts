import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constructionHTTP } from "../../scripts/construction-http.js";
import { benchmarkToken } from "./token.js";
import { tokenize } from "../../src/query/tokenize.js";
const [dir, out] = process.argv.slice(2);
if (!out) throw Error("Use INDEX_DIR OUTPUT.json");
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  source = JSON.parse(
    await readFile("work/columnar-worker-build/source-root.json", "utf8"),
  ),
  token = await benchmarkToken(),
  post = constructionHTTP(4),
  provenance: any[] = [],
  scenarios: any[] = [];
let seed = 20261115,
  next = 0;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const jobs = Array.from({ length: 12 }, () => {
  const doc = Math.floor(random() * root.count),
    part = source.parts.find(
      (p: { first: number; count: number }) =>
        p.first <= doc && doc < p.first + p.count,
    );
  return {
    first: Math.min(doc, part.first + part.count - 4, root.count - 4),
    count: 4,
  };
});
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      let data: any;
      for (let retry = 0; retry < 120; retry++) {
        const r = await post(
            "https://work-search-cws-build-0.phulin.workers.dev/source",
            token,
            JSON.stringify(jobs[i]),
          ),
          text = await r.text();
        if (r.status === 503) {
          await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
          continue;
        }
        if (!r.ok)
          throw Error("Source sample " + r.status + " " + text.slice(0, 400));
        data = JSON.parse(text);
        break;
      }
      if (!data) throw Error("Source capacity retries exhausted");
      // Derive each document's sample from its ID, independent of completion order
      // and with no accelerator directory or benchmark-query input.
      for (const doc of data.rows) {
        const digest = createHash("sha256")
            .update("20261115:" + doc.doc)
            .digest(),
          title = digest[0] % 6 === 0,
          field = title ? "title" : "body",
          words = tokenize(title ? (doc.title ?? "") : doc.body);
        if (words.length < 6) continue;
        const length = 3 + (digest[1] % 4),
          at = digest.readUInt32LE(2) % (words.length - length + 1),
          window = words.slice(at, at + length),
          phrase = '"' + window.join(" ") + '"',
          options = { field: digest[6] % 3 === 0 ? field : "all" };
        scenarios.push({
          q: phrase,
          kind: "source-natural-phrase",
          options,
          sourceDoc: doc.doc,
          sourceAt: at,
        });
        if (digest[7] % 2) {
          const alternate =
              words[(at + Math.floor(words.length / 2)) % words.length],
            mutated = [...window];
          mutated[1] = alternate;
          scenarios.push({
            q: '"' + mutated.join(" ") + '"',
            kind: "source-mutated-phrase",
            options,
            sourceDoc: doc.doc,
            sourceAt: at,
          });
        } else
          scenarios.push({
            q: '"' + window[0] + '" +' + length + ' "' + window.at(-1) + '"',
            kind: "source-ordered-proximity",
            options,
            sourceDoc: doc.doc,
            sourceAt: at,
          });
        provenance.push({
          doc: doc.doc,
          id: doc.id,
          field,
          at,
          length,
          textSha256: createHash("sha256")
            .update(title ? (doc.title ?? "") : doc.body)
            .digest("hex"),
        });
      }
    }
  }),
);
scenarios.sort(
  (a, b) => a.sourceDoc - b.sourceDoc || a.kind.localeCompare(b.kind),
);
await writeFile(out, JSON.stringify(scenarios, null, 2));
await writeFile(
  out + ".provenance.json",
  JSON.stringify(
    {
      seed: 20261115,
      corpusHash: root.corpusHash,
      count: root.count,
      jobs,
      provenance: provenance.sort((a, b) => a.doc - b.doc),
      selection:
        "Uniform document samples; deterministic token windows; no accelerator or benchmark-query input",
      scenarios: scenarios.length,
    },
    null,
    2,
  ),
);
console.log({ scenarios: scenarios.length, documents: provenance.length });
