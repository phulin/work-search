import { readFile, writeFile } from "node:fs/promises";
import { decodePairRoot, decodePairEntry } from "../src/global/pairs.js";
import { GlobalIndex } from "../src/global/search.js";
import { Dictionary } from "../src/global/format.js";
import { PageReader } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { PairCostBuilder } from "../src/global/pair-costs.js";
const dir = process.argv[2],
  bundle = process.argv[3] ?? "work/global-100k/bundle-heads-8.bin";
if (!dir) throw Error("Usage: build-pair-costs <pair directory> [base bundle]");
const index = new GlobalIndex(await readFile(bundle)),
  root = decodePairRoot(await readFile(dir + "/pairs.bin"), index.root),
  disk = new FileStorage(dir + "/packs/" + root.root.generation);
const reader = new PageReader(root.root, {
    read: (k, o, n) => disk.read(k.split("/").at(-1)!, o, n),
  }),
  builder = new PairCostBuilder(index.root.generation, root.root.generation);
const vocabulary = new Set<string>();
let count = 0;
const start = performance.now();
for (let at = 0; at < root.root.dictionary.length; at += 32) {
  const bytes = await reader.readMany(
    root.root.dictionary.slice(at, at + 32).map((p) => p.address),
    "pair-cost-build",
  );
  for (const b of bytes)
    for (const [k, v] of new Dictionary(b).entries()) {
      builder.add(k, decodePairEntry(v).df);
      for (const term of k.split("\0")) vocabulary.add(term);
      count++;
    }
}
const baseDisk = new FileStorage(
  bundle.slice(0, bundle.lastIndexOf("/")) + "/packs",
);
const baseReader = new PageReader(index.root, {
  read: (k, o, n) => baseDisk.read(k.split("/").at(-1)!, o, n),
});
const dfs = new Map<string, number>();
const terms = [...vocabulary].sort();
for (let at = 0; at < terms.length; at += 16)
  for (const [term, p] of await index.terms(
    terms.slice(at, at + 16),
    baseReader,
    128 * 1048576,
  ))
    dfs.set(term, p.df);
const bytes = builder.finish(dfs);
await writeFile(dir + "/costs.bin", bytes);
console.log(
  JSON.stringify({
    pairs: count,
    bytes: bytes.length,
    seconds: (performance.now() - start) / 1000,
    base: index.root.generation,
    generation: root.root.generation,
  }),
);
