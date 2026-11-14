/** Reuse metadata only for this order-preserving, same-corpus conversion. */
import {
  readFile,
  writeFile,
  mkdir,
  symlink,
  realpath,
} from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { MetadataIndex } from "../../src/columnar/metadata-filter.js";
const [sourceIndex, sourceMetadata, targetIndex] = process.argv.slice(2);
if (!targetIndex)
  throw Error(
    "Usage: rebind-verification-metadata.ts SOURCE_INDEX SOURCE_METADATA CONVERTED_INDEX",
  );
const read = async (path: string) => JSON.parse(await readFile(path, "utf8")),
  [source, target, conversion, manifest] = await Promise.all([
    read(sourceIndex + "/root.json"),
    read(targetIndex + "/root.json"),
    read(targetIndex + "/documents-report.json"),
    read(sourceMetadata + "/metadata.json"),
  ]);
new MetadataIndex(manifest, source);
const { generation: oldGeneration, ...oldIdentity } = manifest;
if (
  createHash("sha256").update(JSON.stringify(oldIdentity)).digest("hex") !==
    oldGeneration ||
  source.generation !== conversion.sourceGeneration ||
  source.count !== target.count ||
  source.count !== conversion.documents ||
  source.corpusHash !== target.corpusHash ||
  source.analysis !== target.analysis
)
  throw Error(
    "Metadata reuse requires the verified same-corpus document conversion",
  );
const identity = { ...oldIdentity, baseGeneration: target.generation },
  next = {
    generation: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex"),
    ...identity,
  },
  dir = targetIndex + "/metadata";
new MetadataIndex(next, target);
await mkdir(dir, { recursive: true });
const objects = resolve(sourceMetadata, "objects");
await symlink(objects, dir + "/objects").catch(async (error) => {
  if (error.code !== "EEXIST" || (await realpath(dir + "/objects")) !== objects)
    throw error;
});
await writeFile(dir + "/metadata.json", JSON.stringify(next));
await writeFile(
  dir + "/reuse.json",
  JSON.stringify(
    {
      sourceGeneration: source.generation,
      sourceMetadataGeneration: oldGeneration,
      baseGeneration: target.generation,
      metadataGeneration: next.generation,
      count: target.count,
      reason:
        "The document converter retains each source internal ID without reordering.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    generation: next.generation,
    fields: Object.keys(next.schema),
    blocks: next.blocks.length,
  }),
);
