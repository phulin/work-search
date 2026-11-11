import { readFile, writeFile, mkdir, copyFile, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BinaryIndex,
  buildBinary,
  LOCAL,
  type Entry,
} from "../format/index.js";
import { encodeDocuments } from "../format/documents.js";
import { crc32 } from "../format/codec.js";
import { encodeRoot, type Root, type Page } from "../format/paged.js";
/** Repack a completed offline generation without tokenizing or changing posting codecs. */
export async function pageIndex(source: string, out: string) {
  await mkdir(out, { recursive: true });
  const existing = await readFile(join(out, "manifest.json")).then(
    () => true,
    () => false,
  );
  if (existing) throw Error("Output generation already exists");
  const binary = await readFile(join(source, "bundle.bin")),
    index = new BinaryIndex(binary),
    old = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  const hash = (b: Uint8Array | string) =>
    createHash("sha256").update(b).digest("hex");
  if (hash(binary) !== old.bundleSha256 || index.generation !== old.generation)
    throw Error("Source manifest mismatch");
  const generation = hash(index.generation + ":paged-v1:256:4096");
  const directory = join(out, "objects", generation);
  await mkdir(directory, { recursive: true });
  const objects: { key: string; size: number; sha256: string; kind: string }[] =
    [];
  for (const o of old.objects) {
    const bytes = await readFile(join(source, "objects", o.key));
    if (hash(bytes) !== o.sha256) throw Error("Source object mismatch");
    const key = generation + o.key.slice(index.generation.length);
    await copyFile(join(source, "objects", o.key), join(out, "objects", key));
    objects.push({ ...o, key });
  }
  let extra = 0;
  for (let i = 0; i < index.termCount; i++) {
    const e = index.entry(i);
    if (e.object !== LOCAL) extra = Math.max(extra, e.object + 1);
    if (e.positionObject !== LOCAL)
      extra = Math.max(extra, e.positionObject + 1);
  }
  const localKey = `${generation}/frequencies-${extra}.bin`,
    positionKey = `${generation}/positions-${extra}.bin`;
  const local = await open(join(out, "objects", localKey), "w"),
    pos = await open(join(out, "objects", positionKey), "w");
  let f = 0,
    p = 0;
  const entries: Entry[] = [];
  try {
    for (let i = 0; i < index.termCount; i++) {
      const e = index.entry(i);
      if (e.object === LOCAL) {
        await local.writeFile(
          binary.subarray(
            index.local + e.offset,
            index.local + e.offset + e.length,
          ),
        );
        e.object = extra;
        e.offset = f;
        f += e.length;
      }
      if (e.positionObject === LOCAL) {
        await pos.writeFile(
          binary.subarray(
            index.local + e.positionOffset,
            index.local + e.positionOffset + e.positionLength,
          ),
        );
        e.positionObject = extra;
        e.positionOffset = p;
        p += e.positionLength;
      }
      entries.push(e);
    }
  } finally {
    await local.close();
    await pos.close();
  }
  for (const [key, kind] of [
    [localKey, "frequencies"],
    [positionKey, "positions"],
  ]) {
    const b = await readFile(join(out, "objects", key));
    objects.push({ key, kind, size: b.length, sha256: hash(b) });
  }
  const root: Root = {
    version: 1,
    generation,
    count: index.count,
    terms: index.termCount,
    avgBody: index.avgBody,
    avgTitle: index.avgTitle,
    dictionary: [],
    norms: [],
    documents: [],
    dictionarySize: 256,
    documentSize: 4096,
  };
  for (const kind of ["dictionary", "norms", "documents"] as const) {
    const key = `${generation}/${kind}-0.bin`,
      file = await open(join(out, "objects", key), "w");
    let offset = 0;
    try {
      const count = kind === "dictionary" ? index.termCount : index.count,
        step = kind === "dictionary" ? 256 : 4096;
      for (let first = 0; first < count; first += step) {
        let bytes: Uint8Array;
        if (kind === "dictionary")
          bytes = buildBinary(
            generation,
            entries.slice(first, first + step),
            encodeDocuments([]),
            0,
            [],
            index.avgBody,
            index.avgTitle,
          );
        else if (kind === "documents")
          bytes = encodeDocuments(
            Array.from({ length: Math.min(step, count - first) }, (_, j) =>
              index.document(first + j),
            ),
          );
        else {
          bytes = new Uint8Array(Math.min(step, count - first) * 8);
          const v = new DataView(bytes.buffer);
          for (let j = first; j < Math.min(count, first + step); j++) {
            const d = index.lengths(j);
            v.setUint32((j - first) * 8, d.body, true);
            v.setUint32((j - first) * 8 + 4, d.title, true);
          }
        }
        const page: Page = {
          first: kind === "dictionary" ? entries[first].term : String(first),
          offset,
          length: bytes.length,
          crc: crc32(bytes),
        };
        root[kind].push(page);
        await file.writeFile(bytes);
        offset += bytes.length;
      }
    } finally {
      await file.close();
    }
    const bytes = await readFile(join(out, "objects", key));
    objects.push({ key, kind, size: bytes.length, sha256: hash(bytes) });
  }
  const bundle = encodeRoot(root);
  await writeFile(join(out, "bundle.bin"), bundle);
  const manifest = {
    format: 1,
    layout: "paged",
    generation,
    sourceGeneration: index.generation,
    documents: index.count,
    terms: index.termCount,
    bundleBytes: bundle.length,
    bundleSha256: hash(bundle),
    objects,
  };
  await writeFile(
    join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
