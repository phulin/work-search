/** Publish a complete locally constructed index without deploying search. */
import { readFile } from "node:fs/promises";
import { loadServingAssets, servingOptions } from "./columnar-serving.js";
import { DocumentDirectory } from "../src/columnar/document-directory.js";
import { publishAuxiliary } from "./columnar-publication.js";
import { benchmarkToken } from "../bench/columnar/token.js";
const [index] = process.argv.slice(2);
if (!index)
  throw Error(
    "Usage: publish-local-columnar.ts INDEX [--membership DIRECTORY]",
  );
const assets = await loadServingAssets(index, servingOptions()),
  root = assets.root,
  groups = assets.documents
    ? [...new DocumentDirectory(assets.documents).groups()]
    : [],
  objects = [
    ...root.objects.map((o) => ({
      key: o.key ?? `${root.generation}/${o.name}`,
      size: o.size,
      path: index + "/packs/" + o.name,
    })),
    ...groups.map((g) => ({
      key: g.key,
      size: g.bytes,
      path: index + "/objects/" + g.key,
      packageFirst: g.first,
      packageEnd: g.end,
    })),
    ...assets.auxiliary,
  ];
if (new Set(objects.map((o) => o.key)).size !== objects.length)
  throw Error("Duplicate publication keys");
console.log(
  "Publishing",
  objects.length,
  "objects",
  objects.reduce((n, o) => n + o.size, 0),
  "bytes",
  root.generation,
);
if (process.argv.includes("--inventory-only")) process.exit(0);
await publishAuxiliary(
  "https://work-search-cws-upload.phulin.workers.dev",
  await benchmarkToken(),
  objects,
  index + "/local-publication.jsonl",
);
