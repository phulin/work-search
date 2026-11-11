import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { DocumentTable as Baseline } from "./baseline-v2/documents.js";
import { search } from "../src/query/engine.js";
const out = process.argv[2] ?? "bench/generated/1000000-8-smallest";
const index = new BinaryIndex(await readFile(out + "/bundle.bin"));
if (process.argv.includes("--baseline"))
  Object.defineProperty(index, "documents", {
    value: new Baseline(
      index.bytes.subarray(index.docs, index.local),
      index.count,
    ),
  });
const store = new FileStorage(out + "/objects");
for (let pass = 0; pass < 12; pass++)
  for (const q of ["document", "search engine", "category1 word0", "word19999"])
    await search(index, store, q, { exactTotal: true });
