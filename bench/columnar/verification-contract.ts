/** Refresh rendering references locally, retaining the independent old oracle. */
import { readFile, writeFile } from "node:fs/promises";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { Reader, Memory } from "../../src/columnar/storage.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { PairRouter } from "../../src/columnar/pair-router.js";
import { LocalObjects } from "./local-storage.js";
import {
  loadServingAssets,
  localServingSource,
} from "../../scripts/columnar-serving.js";
import { MetadataIndex } from "../../src/columnar/metadata-filter.js";
const [dir, pairs, input, output] = process.argv.slice(2);
if (!output)
  throw Error("Usage: verification-contract.ts INDEX PAIRS CONTRACT OUTPUT");
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  contract = JSON.parse(await readFile(input, "utf8")),
  source = new LocalObjects(root, process.env.CWS_LOCAL_DATA ?? dir),
  memory = new Memory();
source.namedDirectory = pairs;
const assets = await loadServingAssets(dir, { membershipDir: pairs }),
  servingSource = localServingSource(source, assets),
  metadata = assets.metadata
    ? new MetadataIndex(assets.metadata, root)
    : undefined;
if (
  (contract.count !== undefined && root.count !== contract.count) ||
  root.corpusHash !== contract.corpusHash ||
  root.analysis !== contract.analysis
)
  throw Error("Contract corpus mismatch");
const index = new ColumnarIndex(
    root,
    undefined,
    new TermDirectory(await readFile(dir + "/directory.bin"), root.count),
    undefined,
    new DocumentDirectory(await readFile(dir + "/documents.bin")),
    {
      router: new PairRouter(await readFile(pairs + "/router.bin")),
      presence: JSON.parse(await readFile(pairs + "/presence.json", "utf8")),
      N: 100,
      M: 1000,
    },
  ),
  scenarios = [];
for (const s of contract.scenarios) {
  const options = {
      ...s.options,
      ...(s.options.generation ? { generation: root.generation } : {}),
      ...(s.options.metadataGeneration
        ? { metadataGeneration: assets.metadata?.generation }
        : {}),
    },
    reader = new Reader(root, servingSource, memory);
  if (options.filter !== undefined) {
    if (!metadata) throw Error("Missing metadata for reference filter");
    options.documentFilter = metadata.filter(options.filter, reader);
  }
  if (options.after) {
    const prefix = await index.search(s.q, reader, {
      ...options,
      after: undefined,
    });
    const last = prefix.results.at(-1)!;
    if (last.doc !== options.after.doc)
      throw Error("Pagination reference boundary changed");
    options.after = { doc: last.doc, score: last.score };
  }
  const result = await index.search(s.q, reader, options);
  if (
    result.results.length !== s.oracle.length ||
    result.results.some(
      (h, i) =>
        h.id !== s.oracle[i].id ||
        Math.abs(h.score - s.oracle[i].score) >
          1e-11 * Math.max(1, Math.abs(s.oracle[i].score)),
    )
  )
    throw Error("Independent ranking mismatch: " + s.q);
  if (s.options.exactTotal && result.total !== s.total)
    throw Error("Exact total mismatch");
  scenarios.push({
    ...s,
    optionsByVariant: {
      control: s.options,
      candidate: { ...options, documentFilter: undefined },
    },
    oracle: result.results,
    oracleByVariant: { control: s.oracle, candidate: result.results },
  });
  console.log("Verified", scenarios.length, s.q);
}
await writeFile(
  output,
  JSON.stringify(
    {
      ...contract,
      generation: root.generation,
      count: root.count,
      metadataGenerations: {
        control: contract.metadataGeneration,
        candidate: assets.metadata?.generation,
      },
      generations: { control: contract.generation, candidate: root.generation },
      scenarios,
    },
    null,
    2,
  ),
);
