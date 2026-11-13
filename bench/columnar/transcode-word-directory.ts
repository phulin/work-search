import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { deepStrictEqual } from "node:assert/strict";
import { decodeWords as decodeCompressedWords } from "./control/compressed-word-directory.js";
import {
  encodeWords,
  decodeWords,
  assembleWords,
  WordDirectory,
} from "../../src/columnar/word-directory.js";
import { view } from "../../src/columnar/format.js";
import type { DirectoryBlock } from "../../src/columnar/term-directory.js";
const [source, out] = process.argv.slice(2);
if (!out) throw Error("Use COMPRESSED_WORD_DIRECTORY OUTPUT_DIRECTORY");
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(source + "/manifest.json", "utf8")),
  bytes = await readFile(source + "/words-512.bin"),
  v = view(bytes),
  variants = [512, 2048].map((size) => ({
    size,
    pending: [] as string[],
    blocks: [] as DirectoryBlock[],
    rawBytes: 0,
  })),
  samples = new Map<string, number>(),
  started = performance.now();
let count = 0;
if (
  createHash("sha256").update(bytes).digest("hex") !==
  manifest.variants.find((v: any) => v.blockSize === 512).sha256
)
  throw Error("Source vocabulary digest mismatch");
function flush(item: (typeof variants)[number]) {
  if (!item.pending.length) return;
  const data = encodeWords(item.pending);
  deepStrictEqual(decodeWords(data), item.pending);
  item.blocks.push({
    first: item.pending[0],
    count: item.pending.length,
    data,
  });
  item.rawBytes += data.length;
  item.pending = [];
}
for (let i = 0; i < v.getUint32(8, true); i++) {
  const p = 16 + i * 20,
    at = v.getUint32(p + 8, true),
    n = v.getUint32(p + 12, true);
  for (const word of decodeCompressedWords(
    gunzipSync(bytes.subarray(at, at + n)),
  )) {
    count++;
    if (count % 1024 === 0 || count === 1) samples.set(word, count);
    for (const item of variants) {
      item.pending.push(word);
      if (item.pending.length === item.size) flush(item);
    }
  }
}
if (count !== manifest.count) throw Error("Incomplete transcoded vocabulary");
const results = [];
for (const item of variants) {
  flush(item);
  const data = assembleWords(item.blocks),
    directory = new WordDirectory(data);
  deepStrictEqual(await directory.lookup([...samples.keys()]), samples);
  await writeFile(out + `/words-${item.size}.bin`, data);
  results.push({
    blockSize: item.size,
    bytes: data.length,
    rawBytes: item.rawBytes,
    blocks: item.blocks.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const result = {
  ...manifest,
  format: "CWI2 with direct 32-word restarts",
  elapsedMs: performance.now() - started,
  variants: results,
  note: "Every word round-tripped exactly from the validated complete native CWI1 vocabulary; sampled lexical ordinal lookups also matched. No serving posting metadata.",
};
await writeFile(out + "/manifest.json", JSON.stringify(result, null, 2));
console.log(result);
