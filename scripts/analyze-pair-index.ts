import { readFile } from "node:fs/promises";
import { BinaryIndex, LOCAL } from "../src/format/index.js";
import { loadPosting, type Read } from "../src/query/load.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { decodePairRoot, PairFilter } from "../src/global/pairs.js";
import { decodeRoot } from "../src/global/format.js";
import { PageReader } from "../src/global/storage.js";
import { tokenize } from "../src/query/tokenize.js";
import { SearchRuntime } from "../src/query/runtime.js";
const args = process.argv.slice(2),
  coverageOnly = args.includes("--coverage-only"),
  intersectPairs = args.includes("--intersect-pairs");
const [source, base, pairs, ...phrases] = args.filter(
  (arg) => arg !== "--coverage-only" && arg !== "--intersect-pairs",
);
if (!phrases.length)
  throw Error(
    "Usage: analyze-pair-index SOURCE BASE_BUNDLE PAIRS_DIR PHRASE... [--coverage-only] [--intersect-pairs]",
  );
const index = new BinaryIndex(await readFile(source + "/bundle.bin")),
  disk = new FileStorage(source + "/objects"),
  root = decodePairRoot(
    await readFile(pairs + "/pairs.bin"),
    decodeRoot(await readFile(base)).root,
  ),
  reader = new PageReader(
    root.root,
    new FileStorage(pairs + "/packs"),
    new SearchRuntime(0),
  ),
  filter = new PairFilter(root, reader, 32768, intersectPairs);
const read: Read = async (e, positions, offset, length) => {
  const object = positions ? e.positionObject : e.object,
    start = (positions ? e.positionOffset : e.offset) + offset;
  return object === LOCAL
    ? index.bytes.subarray(index.local + start, index.local + start + length)
    : disk.read(
        index.key(object, positions ? "positions" : "frequencies"),
        start,
        length,
      );
};
for (const phrase of phrases) {
  const terms = tokenize(phrase);
  let intersection: Set<number> | undefined;
  for (const term of new Set(terms)) {
    const entry = index.lookup(term);
    const docs = entry
      ? new Set((await loadPosting(entry, false, read)).docs)
      : new Set<number>();
    intersection = intersection
      ? new Set([...intersection].filter((doc) => docs.has(doc)))
      : docs;
  }
  reader.clearTrace();
  const started = coverageOnly ? 0 : performance.now(),
    candidates = await filter.candidates(terms);
  const within = candidates
    ? [...candidates].filter((doc) => intersection?.has(doc)).length
    : intersection?.size;
  console.log(
    JSON.stringify({
      phrase,
      unigramIntersection: intersection?.size,
      pairCandidates: candidates?.size ?? null,
      afterIntersection: within,
      reduction: intersection?.size ? 1 - within! / intersection.size : 0,
      ...(coverageOnly
        ? {}
        : {
            requests: reader.rounds.reduce((n, r) => n + r.requests, 0),
            bytes: reader.rounds.reduce((n, r) => n + r.bytes, 0),
            rounds: reader.rounds.length,
            ms: performance.now() - started,
          }),
    }),
  );
}
