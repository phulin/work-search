import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual, ok } from "node:assert/strict";
import {
  loadServingAssets,
  localServingSource,
} from "../../scripts/columnar-serving.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import { Reader } from "../../src/columnar/storage.js";
import { benchmarkToken } from "./token.js";

const [directory, referencePath, output] = process.argv.slice(2);
if (!output) throw Error("Use INDEX_DIRECTORY SOURCE_ORACLE_JSON OUTPUT_JSON");
const reference = JSON.parse(await readFile(referencePath, "utf8"));
const assets = await loadServingAssets(directory),
  root = assets.root;
deepStrictEqual(
  [root.generation, root.corpusHash, root.count],
  [reference.generation, reference.corpusHash, reference.count],
);
const index = new ColumnarIndex(
  root,
  undefined,
  new TermDirectory(assets.directory!, root.count),
  undefined,
  new DocumentDirectory(assets.documents!),
  assets.membership,
);
const objects = new OfflineObjects(directory, root, {
  url: "https://work-search-cws-upload.phulin.workers.dev",
  token: await benchmarkToken(),
});
const source = localServingSource(objects.source, assets),
  rows: any[] = [];
let maxRelativeScoreDifference = 0;
try {
  for (const [i, c] of reference.scenarios.entries()) {
    const actual = await index.search(c.q, new Reader(root, source), {
      ...c.options,
      exactTotal: false,
    });
    deepStrictEqual(
      actual.results.map((h) => [h.doc, h.id, h.title, h.metadata]),
      c.oracle.map((h: any) => [h.doc, h.id, h.title, h.metadata]),
      c.q,
    );
    for (let n = 0; n < actual.results.length; n++) {
      const error =
        Math.abs(actual.results[n].score - c.oracle[n].score) /
        Math.max(1, Math.abs(c.oracle[n].score));
      ok(error <= 1e-11, c.q + " score");
      maxRelativeScoreDifference = Math.max(maxRelativeScoreDifference, error);
    }
    // An underfilled oracle heap establishes the exact count independently.
    let totalChecked = false;
    if (!c.options?.after && c.oracle.length < (c.options?.limit ?? 20)) {
      const counted = await index.search(c.q, new Reader(root, source), {
        ...c.options,
        exactTotal: true,
      });
      deepStrictEqual(counted.total, c.oracle.length, c.q + " total");
      totalChecked = true;
    }
    rows.push({
      q: c.q,
      kind: c.kind,
      options: c.options,
      results: actual.results.length,
      totalChecked,
      passed: true,
    });
    if (i % 16 === 0)
      console.log("Validated queries", i + 1, "/", reference.scenarios.length);
  }
} finally {
  await objects.close();
}
await writeFile(
  output,
  JSON.stringify(
    {
      generation: root.generation,
      corpusHash: root.corpusHash,
      count: root.count,
      independentDfVerified: reference.independentDfVerified,
      independentGlobalStatsVerified: reference.independentGlobalStatsVerified,
      queries: rows.length,
      maxRelativeScoreDifference,
      completedAt: new Date().toISOString(),
      rows,
    },
    null,
    2,
  ),
);
console.log(
  "Validated",
  rows.length,
  "queries; maximum relative score difference",
  maxRelativeScoreDifference,
);
