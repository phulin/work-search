/** Fresh workload for this iteration. Expected results come from the frozen
 * pre-change runtime, not an independent exhaustive oracle. No remote access. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalObjects } from "./local-storage.js";
const control = "work/cold-packets-control",
  indexDir = "work/complete-context-v2-1m";
const load = (name: string) =>
  import(pathToFileURL(resolve(control, "src/columnar/" + name + ".ts")).href);
const [
  { ColumnarIndex },
  { Reader, Memory, Lru },
  { TermDirectory },
  { DocumentDirectory },
  { PairRouter },
  { ExactPhraseDirectory },
] = await Promise.all(
  [
    "search",
    "storage",
    "term-directory",
    "document-directory",
    "pair-router",
    "exact-phrase-directory",
  ].map(load),
);
const root = JSON.parse(await readFile(indexDir + "/root.json", "utf8")),
  base = JSON.parse(
    await readFile("work/io-iteration/expanded-contract.json", "utf8"),
  ),
  source = new LocalObjects(root, indexDir),
  directory = new TermDirectory(
    await readFile(indexDir + "/directory.bin"),
    root.count,
  ),
  index = new ColumnarIndex(
    root,
    undefined,
    directory,
    undefined,
    new DocumentDirectory(await readFile(indexDir + "/documents.bin")),
    {
      router: new PairRouter(await readFile(indexDir + "/router.bin")),
      N: 100,
      M: 1000,
      presence: JSON.parse(await readFile(indexDir + "/presence.json", "utf8")),
      exactPhrases: new ExactPhraseDirectory(
        await readFile(indexDir + "/exact-phrases.bin"),
      ),
    },
  );
source.namedDirectory = indexDir;
const queries = [
  '"statute of frauds" AND "part performance"',
  '"qualified immunity" AND "clearly established" AND ("police officer" OR detective)',
  '"res judicata" AND "transactional test"',
  '"personal jurisdiction" AND "internet sales"',
  'mootness AND "voluntary cessation" AND government',
  '"medical malpractice" AND ("expert affidavit" OR "standard of care")',
  '"ineffective assistance" W/P ("guilty plea" AND prejudice)',
  '"actual innocence" AND ("new evidence" OR "procedural default")',
  '"premises liability" AND ("open and obvious" OR invitee)',
  '"adverse possession" AND ("hostile possession" OR "color of title")',
  '"trade secret" AND (disclosure OR confidentiality) AND "reasonable efforts"',
  '"attorney client privilege" AND ("crime fraud" OR waiver)',
  '"federal preemption" AND ("savings clause" OR "express preemption")',
  '"exhaustion of remedies" AND ("futility exception" OR "administrative appeal")',
  "bankruptcy OR probate OR trademark",
  'court AND (evidence OR appeal) AND NOT "summary judgment"',
  '"saffron zeppelin adjudication" OR "copper platypus"',
  "naïve OR café",
  '"had had" OR "that that"',
  '"as a matter of" AND evidence',
  '"breach of contract" W/10 damages',
  '"strict liability" AND NOT ("design defect" OR "failure to warn")',
  '("probable cause" OR "reasonable suspicion") AND NOT ("search warrant" W/P automobile)',
  '"insurance policy" AND (ambiguity OR exclusion) AND "duty to defend"',
  '"tortious interference" AND "economic advantage"',
  '"speedy trial" W/P (waiver OR continuance)',
  '"equal protection" AND ("rational basis" OR "strict scrutiny")',
  '"double jeopardy" AND (acquittal OR mistrial)',
  '"eminent domain" AND "just compensation"',
  '"abuse of discretion" AND "new trial" AND "newly discovered"',
  '"in re" AND bankruptcy',
  '"united states" AND "motion to suppress"',
];
if (queries.some((q) => base.scenarios.some((s: any) => s.q === q)))
  throw Error("Held-out query duplicates training workload");
const scenarios = [];
for (const [i, q] of queries.entries()) {
  const options = {
      limit: 20,
      metadata: true,
      snippets: true,
      exactTotal: false,
      field: i === 30 ? "title" : i === 31 ? "body" : "all",
    },
    memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  directory.clear();
  const result = await index.search(
    q,
    new Reader(root, source, memory),
    options,
  );
  scenarios.push({
    q,
    kind: "heldout-cold-followup",
    options,
    oracle: result.results,
    total: result.total,
  });
  console.log(i + 1, q, result.results.length);
}
await mkdir("work/cold-followup", { recursive: true });
await writeFile(
  "work/cold-followup/heldout-contract.json",
  JSON.stringify({
    ...base,
    scenarios,
    reference: "frozen 51ba38f; not exhaustive",
    createdAt: new Date().toISOString(),
  }),
);
