/** Additional query contracts from the separately frozen pre-change engine.
 * Index selection never reads this file. Independent small tests remain separate. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalObjects } from "./local-storage.js";
const load = (n: string) =>
  import(
    pathToFileURL(resolve("work/phrase-control/src/columnar/" + n + ".ts")).href
  );
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
const dir = "work/verification-1m",
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  source = new LocalObjects(root, dir);
source.namedDirectory = dir;
const index = new ColumnarIndex(
  root,
  undefined,
  new TermDirectory(await readFile(dir + "/directory.bin"), root.count),
  undefined,
  new DocumentDirectory(await readFile(dir + "/documents.bin")),
  {
    router: new PairRouter(await readFile(dir + "/router.bin")),
    N: 100,
    M: 1000,
    presence: JSON.parse(await readFile(dir + "/presence.json", "utf8")),
  },
);
const contract = JSON.parse(
  await readFile("work/io-iteration/contract.json", "utf8"),
);
for (const [q, field] of [
  ['"in the absence of"', "all"],
  ['"in the absence of"', "title"],
  ['"above the absence of"', "all"],
  ['"under the absence of"', "body"],
]) {
  const options = {
      field,
      limit: 20,
      exactTotal: true,
      metadata: true,
      snippets: true,
    },
    memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  const result = await index.search(
    q,
    new Reader(root, source, memory),
    options,
  );
  contract.scenarios.push({
    q,
    kind: "phrase-exact-total",
    options,
    oracle: result.results,
    total: result.total,
  });
  console.log(q, field, "matches", result.total);
}
await writeFile(
  "work/exact-phrases-contract.json",
  JSON.stringify({ ...contract, generation: root.generation }),
);
