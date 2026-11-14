import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import {
  encodeMetadataColumn,
  MetadataIndex,
  type MetadataManifest,
  type MetadataScalar,
  type MetadataSchema,
} from "../src/columnar/metadata-filter.js";
import type { Root } from "../src/columnar/format.js";
import { packageMetadata } from "./columnar-metadata-source.js";

/** Input is explicitly aligned to internal IDs, never assumed corpus order.
 * Export {doc,metadata} from the indexing source or a generation-aware adapter. */
export async function buildMetadata(
  root: Pick<Root, "count" | "generation">,
  schema: MetadataSchema,
  input: AsyncIterable<{ doc: number; metadata: Record<string, unknown> }>,
  out: string,
  blockDocuments = 4096,
) {
  const manifest: MetadataManifest = {
    format: "CWM1",
    generation: "0".repeat(64),
    baseGeneration: root.generation,
    count: root.count,
    blockDocuments,
    schema,
    blocks: [],
  };
  // Validate options before consuming input; full coverage is checked at finish.
  new MetadataIndex(
    {
      ...manifest,
      count: 1,
      blocks: [
        {
          first: 0,
          count: 1,
          columns: Object.fromEntries(
            Object.keys(schema).map((f) => [
              f,
              { key: "a".repeat(64) + "/metadata.bin", bytes: 16 },
            ]),
          ),
        },
      ],
    },
    { ...root, count: 1 },
  );
  await mkdir(out + "/objects", { recursive: true });
  let rows: Record<string, unknown>[] = [],
    count = 0;
  const flush = async () => {
    const first = count - rows.length,
      columns: MetadataManifest["blocks"][number]["columns"] =
        Object.create(null);
    for (const [field, type] of Object.entries(schema)) {
      const bytes = encodeMetadataColumn(
          first,
          type,
          rows.map((r) =>
            Object.hasOwn(r, field)
              ? (r[field] as MetadataScalar | null)
              : undefined,
          ),
        ),
        hash = createHash("sha256").update(bytes).digest("hex");
      await writeFile(out + "/objects/" + hash + ".bin", bytes);
      columns[field] = { key: hash + "/metadata.bin", bytes: bytes.length };
    }
    manifest.blocks.push({ first, count: rows.length, columns });
    rows = [];
  };
  for await (const r of input) {
    if (
      r.doc !== count ||
      count >= root.count ||
      !r.metadata ||
      typeof r.metadata !== "object" ||
      Array.isArray(r.metadata)
    )
      throw Error(
        "Metadata must cover every internal document ID exactly once, in order",
      );
    rows.push(r.metadata);
    count++;
    if (count % 100000 === 0) console.log("Metadata", count, "/", root.count);
    if (rows.length === blockDocuments) await flush();
  }
  if (count !== root.count)
    throw Error("Incomplete metadata document coverage");
  if (rows.length) await flush();
  const { generation: _pending, ...identity } = manifest;
  manifest.generation = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  new MetadataIndex(manifest, root);
  await writeFile(out + "/metadata.json", JSON.stringify(manifest));
  return manifest;
}
if (process.argv[1]?.endsWith("build-columnar-metadata.ts")) {
  const [index, schemaFile, inputFile, out] = process.argv.slice(2);
  if (!out)
    throw Error(
      "Usage: yarn node --import tsx scripts/build-columnar-metadata.ts INDEX_DIR SCHEMA_JSON DOC_METADATA_JSONL OUTPUT_DIR",
    );
  const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
    schema = JSON.parse(await readFile(schemaFile, "utf8"));
  async function* records() {
    for await (const line of createInterface({
      input: createReadStream(inputFile),
      crlfDelay: Infinity,
    }))
      if (line.trim()) yield JSON.parse(line);
  }
  const m = await buildMetadata(
    root,
    schema,
    inputFile === "--packages"
      ? packageMetadata(index, undefined, root)
      : records(),
    out,
  );
  console.log(
    JSON.stringify({
      documents: m.count,
      blocks: m.blocks.length,
      fields: Object.keys(m.schema),
    }),
  );
}
