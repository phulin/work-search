/** Local-only frozen-runtime references. These supplement, not replace, the
 * independent exhaustive oracle. No source downloads or Cloudflare access. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalObjects } from "./local-storage.js";
const [control, output] = process.argv.slice(2);
if (!output)
  throw Error("Usage: io-iteration-contract.ts FROZEN_SOURCE OUTPUT.json");
const load = (name: string) =>
  import(pathToFileURL(resolve(control, "src/columnar/" + name + ".ts")).href);
const [
  { ColumnarIndex },
  { Reader, Memory, Lru },
  { TermDirectory },
  { DocumentDirectory },
  { PairRouter },
] = await Promise.all(
  [
    "search",
    "storage",
    "term-directory",
    "document-directory",
    "pair-router",
  ].map(load),
);
const dir = process.env.CWS_REFERENCE_INDEX ?? "work/columnar-worker-stem-1m",
  pairs = process.env.CWS_REFERENCE_PAIRS ?? "work/columnar-complete-pairs-1m",
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  source = new LocalObjects(
    root,
    process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
  ),
  memory = new Memory(),
  directory = new TermDirectory(
    await readFile(dir + "/directory.bin"),
    root.count,
  ),
  index = new ColumnarIndex(
    root,
    undefined,
    directory,
    undefined,
    new DocumentDirectory(await readFile(dir + "/documents.bin")),
    {
      router: new PairRouter(await readFile(pairs + "/router.bin")),
      N: 100,
      M: 1000,
      presence: JSON.parse(await readFile(pairs + "/presence.json", "utf8")),
    },
  );
memory.pages = new Lru(12 * 1048576);
source.namedDirectory = pairs;
const existing = JSON.parse(
    await readFile(
      "bench/results/columnar/research-180-1m/queries.json",
      "utf8",
    ),
  ).queries,
  unfamiliar = [
    '"equitable tolling" AND diligence AND NOT "class action"',
    '"forum selection" AND (waiver OR consent)',
    '"failure to exhaust" AND (administrative OR remedies)',
    '"clear error" AND "credibility determination"',
    '"public interest" AND (injunction OR "temporary restraining order")',
    '"actual notice" /15 prejudice',
    '"business judgment" AND (fiduciary OR director)',
    '"independent contractor" AND control AND NOT tax',
    '"statutory damages" AND (willful OR discretion)',
    '"trade secret" AND "reasonable measures"',
    '"attorney client" /10 waiver',
    '"newly discovered evidence" AND diligence',
    "(contract OR fraud OR negligence) AND (damages OR causation)",
    '"abuse of discretion" AND NOT ("criminal history" OR "sentencing guidelines")',
    '"burden of production" AND "legitimate reason"',
    '"under the circumstances" AND "in light of"',
    '"to the extent that" AND jurisdiction',
    '"res judicata" AND (privity OR "same transaction")',
    '"plain meaning" AND (ambiguity OR legislative)',
    '"reasonable expectation" /25 privacy',
  ];
const definitions = [
    ...existing.map((s: any) => ({
      q: s.query,
      kind: "research-180",
      options: { limit: 20, metadata: true, snippets: true },
    })),
    ...unfamiliar.map((q, i) => ({
      q,
      kind: "unfamiliar",
      options: {
        limit: 20,
        field: i % 5 === 0 ? "body" : i % 7 === 0 ? "title" : "all",
        exactTotal: i % 3 === 0,
        metadata: true,
        snippets: true,
      },
    })),
  ],
  scenarios: any[] = [];
for (const s of definitions) {
  memory.clear();
  directory.clear();
  const result = await index.search(
    s.q,
    new Reader(root, source, memory),
    s.options,
  );
  scenarios.push({ ...s, total: result.total, oracle: result.results });
  await writeFile(
    output,
    JSON.stringify({
      count: root.count,
      corpusHash: root.corpusHash,
      analysis: root.analysis,
      generation: root.generation,
      reference: control,
      validation:
        "Frozen pre-change runtime; research and unfamiliar cases. Independent exhaustive checks are separate.",
      scenarios,
    }),
  );
  console.log(scenarios.length, s.kind, result.results.length, s.q);
}
