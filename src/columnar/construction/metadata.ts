import {
  encodeMetadataColumn,
  type MetadataSchema,
  type MetadataScalar,
} from "../metadata-filter.js";
import { BuildStore, digest, type Chunk } from "./runs.js";
/** Assemble fixed document ranges from already-read metadata; never re-read text. */
export async function finishMetadata(
  store: BuildStore,
  input: {
    first: number;
    count: number;
    schema: MetadataSchema;
    parts: { first: number; end: number; metadataRef: Chunk }[];
  },
) {
  const rows: Record<string, unknown>[] = [],
    columns: Record<string, { key: string; bytes: number }> = {},
    objects: { key: string; size: number; sha256: string }[] = [];
  let next = input.first;
  for (const part of input.parts) {
    if (part.first !== next || part.end <= next)
      throw Error("Metadata input coverage mismatch");
    const values = JSON.parse(
      new TextDecoder().decode(await store.get(part.metadataRef)),
    );
    if (!Array.isArray(values) || values.length !== part.end - part.first)
      throw Error("Metadata row count mismatch");
    rows.push(...values);
    next = part.end;
  }
  if (rows.length !== input.count || input.count < 1 || input.count > 4096)
    throw Error("Incomplete metadata block");
  for (const [field, type] of Object.entries(input.schema)) {
    const raw = encodeMetadataColumn(
        input.first,
        type,
        rows.map((r) => r[field] as MetadataScalar | undefined),
      ),
      sha256 = await digest(raw),
      key = sha256 + "/metadata.bin";
    await store.bucket.put(key, raw as ArrayBufferView<ArrayBuffer>, {
      sha256,
      customMetadata: { generation: sha256, sha256 },
    });
    columns[field] = { key, bytes: raw.length };
    objects.push({ key, size: raw.length, sha256 });
  }
  return {
    block: { first: input.first, count: input.count, columns },
    objects,
  };
}
