import { open, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  encodeSuffixFenceRecords,
  suffixFenceHeader,
} from "../src/suffix/fences.js";
import type { SuffixManifest, SuffixBlock } from "../src/suffix/format.js";

const [directory] = process.argv.slice(2);
if (!directory) throw Error("Use SUFFIX_DIRECTORY");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest-heads.json", "utf8"),
  ),
  input = await open(directory + "/directory", "r"),
  output = await open(directory + "/fences", "w"),
  started = Date.now();
let bytes = 48,
  count = 0,
  expected = 0;
try {
  for (const group of manifest.directory) {
    const compressed = Buffer.allocUnsafe(group.ref.length);
    if (
      (await input.read(compressed, 0, compressed.length, group.ref.offset))
        .bytesRead !== compressed.length
    )
      throw Error("Truncated suffix directory");
    const blocks: SuffixBlock[] = JSON.parse(gunzipSync(compressed).toString());
    if (blocks[0].first !== expected) throw Error("Suffix fence directory gap");
    const raw = encodeSuffixFenceRecords(blocks);
    await output.write(raw, 0, raw.length, bytes);
    bytes += raw.length;
    count += blocks.length;
    expected = blocks.at(-1)!.first + blocks.at(-1)!.count;
  }
  if (expected !== manifest.rows)
    throw Error("Suffix fence directory row count");
  const header = suffixFenceHeader(
    count,
    manifest.corpusGeneration,
    manifest.rows,
  );
  await output.write(header, 0, header.length, 0);
} finally {
  await input.close();
  await output.close();
}
const hash = createHash("sha256");
for await (const raw of createReadStream(directory + "/fences"))
  hash.update(raw);
manifest.files.fences = { bytes, sha256: hash.digest("hex") };
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(directory + "/manifest-fences.json", JSON.stringify(manifest));
console.log(
  JSON.stringify({
    generation: manifest.generation,
    blocks: count,
    bytes,
    milliseconds: Date.now() - started,
  }),
);
