import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  decodeDirectoryBlock,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../../src/columnar/term-directory.js";
import { view } from "../../src/columnar/format.js";
import { deepStrictEqual } from "node:assert/strict";
import {
  encodeCompactDirectory,
  decodeCompactDirectory,
} from "./compact-directory.js";
const [dir, out] = process.argv.slice(2);
if (!out) throw Error("Usage: directory-layout.ts INDEX_DIR OUTPUT.json");
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  raw = await readFile(dir + "/directory.bin"),
  v = view(raw),
  variants = ["current", "compact"].flatMap((codec) =>
    [128, 256, 512, 1024].map((size) => ({
      codec,
      size,
      entries: [] as [string, DirectoryTerm][],
      bytes: 16,
      blocks: 0,
      rawBytes: 0,
    })),
  ),
  statistics = {
    terms: 0,
    singleton: 0,
    small: 0,
    ordinalIds: 0,
    derivableSingleBlock: 0,
    bodyOnceOnly: 0,
    embeddedBytes: 0,
  };
function flush(variant: (typeof variants)[number]) {
  if (!variant.entries.length) return;
  const bytes =
    variant.codec === "compact"
      ? encodeCompactDirectory(variant.entries)
      : encodeDirectoryBlock(variant.entries);
  if (variant.codec === "compact")
    deepStrictEqual(
      [...decodeCompactDirectory(bytes, root.count)],
      variant.entries,
    );
  variant.bytes +=
    20 + Buffer.byteLength(variant.entries[0][0]) + gzipSync(bytes).length;
  variant.rawBytes += bytes.length;
  variant.blocks++;
  variant.entries = [];
}
for (let block = 0; block < v.getUint32(8, true); block++) {
  const p = 16 + block * 20,
    at = v.getUint32(p + 8, true),
    n = v.getUint32(p + 12, true),
    entries = decodeDirectoryBlock(
      gunzipSync(raw.subarray(at, at + n)),
      root.count,
    );
  for (const [word, term] of entries) {
    if (term.id === statistics.terms + 1) statistics.ordinalIds++;
    statistics.terms++;
    if (term.df === 1) statistics.singleton++;
    if (!term.tree.height) statistics.small++;
    if (term.bodyOccurrences === term.df && !term.titleOccurrences)
      statistics.bodyOnceOnly++;
    statistics.embeddedBytes += term.embedded?.length ?? 0;
    if (
      !term.tree.height &&
      !term.frequencyParts?.length &&
      JSON.stringify(term.tree.score) ===
        JSON.stringify([
          term.frequencies[0],
          term.frequencies[1] + 72,
          term.frequencies[2] - 72 - term.df * 4,
        ])
    )
      statistics.derivableSingleBlock++;
    for (const variant of variants) {
      variant.entries.push([word, term]);
      if (variant.entries.length === variant.size) flush(variant);
    }
  }
}
for (const variant of variants) flush(variant);
const result = {
  directorySha256: createHash("sha256").update(raw).digest("hex"),
  currentBytes: raw.length,
  statistics,
  variants: variants.map(({ entries: _, ...v }) => v),
  caveat:
    "Offline format-size diagnostic. Lookup CPU and live serving behavior are not measured by this script.",
};
await writeFile(out, JSON.stringify(result, null, 2));
console.log(result);
