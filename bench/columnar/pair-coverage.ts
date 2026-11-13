import { readFile, writeFile } from "node:fs/promises";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { parse, queryTerms } from "../../src/query/parser.js";
import { planPairAnchor } from "../../src/columnar/pair-evidence.js";
const args = process.argv.slice(2),
  selectionAt = args.indexOf("--selection");
const selectionFile =
  selectionAt < 0 ? undefined : args.splice(selectionAt, 2)[1];
const [contracts, out, ...dirs] = args;
if (!out || !dirs.length) throw Error("Use ORACLE OUTPUT INDEX_DIRECTORY...");
if (selectionFile && dirs.length !== 1)
  throw Error("Selection estimates require one base index");
const selection = selectionFile
  ? JSON.parse(await readFile(selectionFile, "utf8"))
  : undefined;
const oracle = JSON.parse(await readFile(contracts, "utf8")),
  results = [];
for (const dir of dirs) {
  const root = JSON.parse(await readFile(dir + "/root.json", "utf8"));
  if (root.corpusHash !== oracle.corpusHash) throw Error("Corpus mismatch");
  if (selection) {
    if (
      selection.corpusHash !== root.corpusHash ||
      selection.documents !== root.count
    )
      throw Error("Selection corpus mismatch");
    root.positionalPairs = Object.fromEntries(
      selection.pairs.map((p: any) => [
        `${p.a}:${p.b}`,
        {
          a: p.a,
          b: p.b,
          df: p.df,
          occurrences: p.occurrences,
          ref: [0, 0, p.cost],
        },
      ]),
    );
  }
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
    ...(selection
      ? { baseGeneration: root.generation, selectionEstimate: true }
      : { generation: root.generation }),
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
