import { readFile, writeFile } from "node:fs/promises";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { parse, queryTerms } from "../../src/query/parser.js";
import { planPairAnchor } from "../../src/columnar/pair-evidence.js";
const [contracts, out, ...dirs] = process.argv.slice(2);
if (!out || !dirs.length) throw Error("Use ORACLE OUTPUT INDEX_DIRECTORY...");
const oracle = JSON.parse(await readFile(contracts, "utf8")),
  results = [];
for (const dir of dirs) {
  const root = JSON.parse(await readFile(dir + "/root.json", "utf8"));
  if (root.corpusHash !== oracle.corpusHash) throw Error("Corpus mismatch");
  const dictionary = new TermDirectory(
      await readFile(dir + "/directory.bin"),
      root.count,
    ),
    rows = [];
  for (const contract of oracle.scenarios) {
    const ast = parse(contract.q, contract.options?.mode),
      terms = await dictionary.lookup(queryTerms(ast)),
      anchor = planPairAnchor(
        ast,
        new Map([...terms].map(([word, t]) => [word, t.id])),
        root,
      );
    rows.push({
      q: contract.q,
      kind: contract.kind,
      field: contract.options?.field,
      ...(anchor
        ? {
            bytes: anchor.bytes,
            df: anchor.df,
            covered: anchor.covered,
            pairs: anchor.pairs.map((p) => ({
              a: p.a,
              b: p.b,
              df: p.df,
              occurrences: p.occurrences,
            })),
          }
        : {}),
    });
  }
  results.push({
    generation: root.generation,
    pairs: Object.keys(root.positionalPairs ?? {}).length,
    queries: rows.length,
    withAnchor: rows.filter((r) => r.df !== undefined).length,
    fullyCovered: rows.filter((r) => r.covered).length,
    rows,
  });
}
await writeFile(
  out,
  JSON.stringify(
    {
      corpusHash: oracle.corpusHash,
      results,
      caveat:
        "Descriptor coverage and DF estimates, not measured candidate intersections or serving latency.",
    },
    null,
    2,
  ),
);
console.log(results.map(({ rows: _, ...result }) => result));
