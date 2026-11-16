import { open, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { SuffixManifest, SuffixBlock } from "../src/suffix/format.js";

/** Add conservative upper-level summaries to a completed immutable suffix
 * generation. Only its small directory is read; aligned posting files are reused. */
const [directory] = process.argv.slice(2);
if (!directory) throw Error("Use SUFFIX_DIRECTORY");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest.json", "utf8"),
  ),
  handle = await open(directory + "/directory", "r");
try {
  for (const group of manifest.directory) {
    const raw = Buffer.allocUnsafe(group.ref.length);
    if (
      (await handle.read(raw, 0, raw.length, group.ref.offset)).bytesRead !==
      raw.length
    )
      throw Error("Truncated suffix directory");
    const blocks: SuffixBlock[] = JSON.parse(gunzipSync(raw).toString());
    if (
      !blocks.length ||
      blocks[0].first !== group.first ||
      blocks.at(-1)!.first + blocks.at(-1)!.count !== group.end
    )
      throw Error("Suffix directory coverage mismatch");
    group.scoreMaximum = Array.from({ length: 4 }, (_, i) =>
      Math.max(...blocks.map((b) => b.scoreMaximum[i])),
    );
    group.minDocument = Math.min(...blocks.map((b) => b.minDocument));
  }
} finally {
  await handle.close();
}
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(directory + "/manifest-max.json", JSON.stringify(manifest));
console.log(
  JSON.stringify({
    generation: manifest.generation,
    groups: manifest.directory.length,
    bytes: JSON.stringify(manifest).length,
  }),
);
