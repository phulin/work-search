import { readFile } from "node:fs/promises";
import { ColumnarIndex } from "../src/columnar/search.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { Heads } from "../src/columnar/heads.js";
import { TermDirectory } from "../src/columnar/term-directory.js";
import { DocumentDirectory } from "../src/columnar/document-directory.js";
import { benchmarkToken } from "../bench/columnar/token.js";
const [dir, q, opts] = process.argv.slice(2);
if (!dir || !q)
  throw Error("Usage: yarn search-local INDEX_DIR QUERY [OPTIONS_JSON]");
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  pairs = await readFile(dir + "/pairs-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  ),
  headRoot = await readFile(dir + "/heads-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  ),
  index = new ColumnarIndex(
    root,
    headRoot
      ? new Heads(headRoot, await readFile(dir + "/heads.bin"), root)
      : undefined,
    root.directory
      ? new TermDirectory(await readFile(dir + "/directory.bin"), root.count)
      : undefined,
    undefined,
    root.documentPackages?.locators
      ? new DocumentDirectory(await readFile(dir + "/documents.bin"))
      : undefined,
  ),
  remote = process.env.CWS_REMOTE_URL
    ? { url: process.env.CWS_REMOTE_URL, token: await benchmarkToken() }
    : undefined,
  objects = new OfflineObjects(dir, root, remote),
  pairObjects = pairs
    ? new OfflineObjects(dir + "/pairs", pairs, remote)
    : undefined,
  memory = new Memory();
const source = (o: OfflineObjects) => o.source;
try {
  console.log(
    JSON.stringify(
      await index.search(
        q,
        new Reader(root, source(objects), memory),
        opts ? JSON.parse(opts) : {},
        pairs && pairObjects
          ? {
              root: pairs,
              reader: new Reader(pairs, source(pairObjects), memory),
            }
          : undefined,
      ),
      null,
      2,
    ),
  );
} finally {
  await objects.close();
  await pairObjects?.close();
}
