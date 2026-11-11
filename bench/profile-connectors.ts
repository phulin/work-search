import { readFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search as current } from "../src/query/engine.js";
import { search as baseline } from "./baseline-v3/engine.js";
const root = "bench/generated/1000000-48-workload",
  index = new BinaryIndex(await readFile(root + "/bundle.bin")),
  store = new FileStorage(root + "/objects");
const search = process.argv.includes("--baseline") ? baseline : current;
for (let pass = 0; pass < 4; pass++)
  for (const q of [
    '"search engine"',
    "document /s engine",
    '"search engine" AND NOT category1',
  ])
    await search(index, store, q);
