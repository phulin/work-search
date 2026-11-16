import { open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { SuffixFenceBuilder } from "../src/suffix/fences.js";
import type { SuffixManifest, SuffixBlock } from "../src/suffix/format.js";
const [directory, manifestName = "manifest-heads.json"] = process.argv.slice(2);
if (!directory) throw Error("Use SUFFIX_DIRECTORY [MANIFEST]");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/" + manifestName, "utf8"),
  ),
  input = await open(directory + "/directory", "r"),
  started = Date.now();
async function blocks(
  group: SuffixManifest["directory"][number],
): Promise<SuffixBlock[]> {
  const raw = Buffer.allocUnsafe(group.ref.length);
  if (
    (await input.read(raw, 0, raw.length, group.ref.offset)).bytesRead !==
    raw.length
  )
    throw Error("Truncated suffix directory");
  return JSON.parse(gunzipSync(raw).toString());
}
let count = 0,
  raw: Uint8Array;
try {
  for (const group of manifest.directory) count += (await blocks(group)).length;
  const builder = new SuffixFenceBuilder(
    count,
    manifest.corpusGeneration,
    manifest.rows,
  );
  for (const group of manifest.directory) builder.append(await blocks(group));
  raw = builder.finish();
} finally {
  await input.close();
}
const sha256 = createHash("sha256").update(raw).digest("hex"),
  name = "fences-" + sha256.slice(0, 16);
await writeFile(directory + "/" + name, raw);
manifest.files[name] = { bytes: raw.length, sha256 };
manifest.fences = name;
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(directory + "/manifest-fences.json", JSON.stringify(manifest));
console.log(
  JSON.stringify({
    generation: manifest.generation,
    blocks: count,
    bytes: raw.length,
    milliseconds: Date.now() - started,
  }),
);
