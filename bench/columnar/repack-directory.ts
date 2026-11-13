import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import {
  TermDirectory,
  assembleTermDirectory,
  assembleTieredDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
  type DirectoryBlock,
} from "../../src/columnar/term-directory.js";
import { view, type Root } from "../../src/columnar/format.js";
import { generationFor } from "../../src/columnar/construction/runs.js";

const [input, out, group] = process.argv.slice(2),
  size = Number(group);
if (
  !input ||
  !out ||
  resolve(input) === resolve(out) ||
  !Number.isInteger(size) ||
  size < 16 ||
  size > 4096
)
  throw Error(
    "Usage: repack-directory.ts INPUT_INDEX OUTPUT_INDEX GROUP_SIZE[16..4096]",
  );
const root: Root = JSON.parse(await readFile(input + "/root.json", "utf8")),
  raw = await readFile(input + "/directory.bin"),
  hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
if (
  root.count !== 1000000 ||
  hash(raw) !== root.directory?.sha256 ||
  root.objects.some((o) => !o.key)
)
  throw Error(
    "Repacking requires a validated immutable 1M index with explicit object keys",
  );
const started = performance.now(),
  before = createHash("sha256"),
  directory = new TermDirectory(raw, root.count),
  blocks: DirectoryBlock[] = [];
let pending: [string, DirectoryTerm][] = [];
function flush() {
  if (!pending.length) return;
  blocks.push({
    first: pending[0][0],
    count: pending.length,
    data: gzipSync(encodeDirectoryBlock(pending)),
  });
  pending = [];
}
for await (const entry of directory.bundledEntries()) {
  before
    .update(entry[0])
    .update("\0")
    .update(JSON.stringify(entry[1]))
    .update("\n");
  pending.push(entry);
  if (pending.length === size) flush();
}
flush();
const hot = assembleTermDirectory(blocks),
  v = view(raw),
  bytes =
    v.getUint32(0, true) === 0x33445443
      ? assembleTieredDirectory(hot, raw.subarray(16 + v.getUint32(8, true)))
      : hot,
  result: Root = {
    ...root,
    generation: "",
    directory: { ...root.directory!, bytes: bytes.length, sha256: hash(bytes) },
  };
const repacked = new TermDirectory(bytes, root.count),
  after = createHash("sha256");
if (repacked.terms !== directory.terms)
  throw Error("Repacked vocabulary coverage mismatch");
for await (const [word, term] of repacked.bundledEntries())
  after.update(word).update("\0").update(JSON.stringify(term)).update("\n");
const decodedMetadataSha256 = before.digest("hex");
if (after.digest("hex") !== decodedMetadataSha256)
  throw Error("Repacking changed decoded words, counts, bounds or addresses");
result.generation = await generationFor(result);
await mkdir(out, { recursive: true });
await writeFile(out + "/directory.bin", bytes);
if (root.documentPackages?.locators)
  await copyFile(input + "/documents.bin", out + "/documents.bin");
await writeFile(out + "/root.json", JSON.stringify(result));
const report = {
  kind: "Local directory regrouping; exact metadata and all posting/package addresses retained",
  sourceGeneration: root.generation,
  generation: result.generation,
  documents: root.count,
  analysis: root.analysis,
  groupSize: size,
  bundledTerms: directory.bundledTerms,
  terms: directory.terms,
  originalDirectoryBytes: raw.length,
  directoryBytes: bytes.length,
  decodedMetadataSha256,
  elapsedMs: performance.now() - started,
};
await writeFile(out + "/repacking.json", JSON.stringify(report, null, 2));
console.log(report);
