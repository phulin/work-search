import {
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadServingAssets,
  servingOptions,
} from "../../scripts/columnar-serving.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import type { SuffixManifest } from "../../src/suffix/format.js";
import { RangeStorage } from "./range-storage.js";
import { writePreparedRanges, type RangeSnapshot } from "./range-snapshot.js";
import type { ReadRange } from "./read-ranges.js";

const [indexPath, suffixPath, capturePath, output] = process.argv.slice(2);
if (!output)
  throw Error("Use INDEX_DIR SUFFIX_DIR CAPTURE_JSON NEW_OUTPUT_DIR");
if (
  await stat(output).then(
    () => true,
    (e) => {
      if (e.code !== "ENOENT") throw e;
      return false;
    },
  )
)
  throw Error("Output directory must not already exist");
const assets = await loadServingAssets(indexPath, servingOptions()),
  root = assets.root,
  manifestName = process.env.CWS_SUFFIX_MANIFEST ?? "manifest-numeric.json",
  manifest: SuffixManifest = JSON.parse(
    await readFile(join(suffixPath, manifestName), "utf8"),
  ),
  capture = JSON.parse(await readFile(capturePath, "utf8")) as {
    generation: string;
    suffixGeneration: string;
    corpusHash: string;
    engine: ReadRange[];
    suffix: ReadRange[];
  };
if (
  capture.generation !== root.generation ||
  capture.corpusHash !== root.corpusHash ||
  capture.suffixGeneration !== manifest.generation ||
  manifest.corpusGeneration !== root.generation
)
  throw Error("Captured benchmark data belongs to a different generation");
const storage = new RangeStorage(root, join(indexPath, "local-ranges"));
storage.include(
  [...new DocumentDirectory(assets.documents!).groups()].map((g) => ({
    key: g.key,
    size: g.bytes,
    sha256: g.key.split("/")[0],
  })),
);
await storage.verify();
const engineOut = join(output, "engine"),
  suffixOut = join(output, "suffix");
async function copy(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
// These are serving assets, not the source corpus or construction intermediates.
for (const name of [
  "root.json",
  "directory.bin",
  "documents.bin",
  "membership/router.bin",
  "membership/presence.json",
  "membership/exact-phrases.bin",
  "metadata/metadata.json",
])
  await copy(join(indexPath, name), join(engineOut, name));
await copy(join(suffixPath, manifestName), join(suffixOut, manifestName));
for (const name of new Set(
  [
    manifest.fences ?? "fences",
    "intervals",
    manifest.phraseRanks,
    manifest.phraseRankIndex,
    manifest.numericPackets?.index,
  ].filter((n): n is string => !!n),
)) {
  if (!resolve(suffixPath, name).startsWith(resolve(suffixPath) + "/"))
    throw Error("Invalid suffix file name");
  await copy(join(suffixPath, name), join(suffixOut, name));
}
const engine = await writePreparedRanges(
  capture.engine,
  join(engineOut, "local-ranges"),
  (k, o, n) => storage.read(k, o, n),
);
const suffix = await writePreparedRanges(
  capture.suffix,
  join(suffixOut, "local-ranges"),
  async (key, offset, length) => {
    if (
      !manifest.files[key] ||
      offset + length > manifest.files[key].bytes ||
      !resolve(suffixPath, key).startsWith(resolve(suffixPath) + "/")
    )
      throw Error("Invalid suffix range");
    const handle = await open(join(suffixPath, key), "r");
    try {
      const bytes = Buffer.allocUnsafe(length);
      if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length)
        throw Error("Truncated suffix range");
      return bytes;
    } finally {
      await handle.close();
    }
  },
);
for (const [directory, generation, sizes] of [
  [engineOut, root.generation, engine],
  [suffixOut, manifest.generation, suffix],
] as const) {
  const snapshot: RangeSnapshot = {
    format: "benchmark-ranges-1",
    generation,
    corpusHash: root.corpusHash!,
    ...sizes,
  };
  await writeFile(
    join(directory, "range-snapshot.json"),
    JSON.stringify(snapshot),
  );
}
await copy(capturePath, join(output, "coverage.json"));
await copy(
  process.env.CWS_CONTRACT_PATH ?? "bench/fixtures/1m-200.json.gz",
  join(output, "contract.json.gz"),
);
console.log(JSON.stringify({ output, engine, suffix }));
