import { readFile, writeFile, mkdir, copyFile, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BinaryIndex,
  buildBinary,
  LOCAL,
  type Entry,
} from "../format/index.js";
import { FileStorage } from "../storage/filesystem.js";
import { selectStreams } from "./selection.js";
import { parse, queryTerms } from "../query/parser.js";
import { encodeIds } from "../format/ids.js";
import { encodeDocuments } from "../format/documents.js";
import { crc32 } from "../format/codec.js";
import { encodeRoot, type Root, type Page } from "../format/paged.js";
/** Repack a completed offline generation without tokenizing or changing posting codecs. */
export async function pageIndex(
  source: string,
  out: string,
  options: {
    optimizationStep?: number;
    localTables?: boolean;
    budget?: number;
    hotDescriptors?: number;
    embedPostings?: boolean;
    inlineTiny?: boolean;
    workload?: string[];
  } = {},
) {
  const budget = options.budget ?? 8 * 1048576;
  if (
    !Number.isSafeInteger(options.hotDescriptors ?? 0) ||
    (options.hotDescriptors ?? 0) < 0
  )
    throw Error("Invalid hot descriptor count");
  if (options.embedPostings && !options.hotDescriptors)
    throw Error("Embedded streams require hot descriptors");
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 48 * 1048576)
    throw Error("Invalid paged bundle budget");
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
  if (options.localTables && index.count * 8 > budget)
    throw Error("Exact local norms exceed bundle budget");
  const optimized = !!(options.hotDescriptors || options.inlineTiny);
  if (optimized && !options.localTables)
    throw Error("Optimized roots require local tables");
  const generation = hash(
    index.generation +
      (optimized
        ? JSON.stringify({
            hot: options.hotDescriptors ?? 0,
            postings: !!options.embedPostings,
            inline: !!options.inlineTiny,
            workload: options.workload ?? [],
            budget,
          })
        : "") +
      (options.localTables
        ? ":paged-v2:256:4096:local-tables"
        : ":paged-v1:256:4096"),
  );
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
    optimizationStep: options.optimizationStep ?? 0,
    version: optimized ? 3 : options.localTables ? 2 : 1,
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
  const payloadCache = new Map<string, Uint8Array>();
  const payload = async (e: Entry, positions: boolean) => {
    const key = `${generation}/${positions ? "positions" : "frequencies"}-${positions ? e.positionObject : e.object}.bin`;
    let b = payloadCache.get(key);
    if (!b) {
      b = await readFile(join(out, "objects", key));
      payloadCache.set(key, b);
      if (payloadCache.size > 3)
        payloadCache.delete(payloadCache.keys().next().value!);
    }
    const o = positions ? e.positionOffset : e.offset;
    return b.subarray(o, o + (positions ? e.positionLength : e.length));
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
        if (kind === "dictionary") {
          const pageEntries = entries
              .slice(first, first + step)
              .map((e) => ({ ...e })),
            embedded: Uint8Array[] = [];
          let local = 0;
          if (options.inlineTiny)
            for (const e of pageEntries)
              if (e.df <= 256 && e.length + e.positionLength <= 128) {
                const f = await payload(e, false),
                  p = await payload(e, true);
                e.object = LOCAL;
                e.offset = local;
                local += f.length;
                e.positionObject = LOCAL;
                e.positionOffset = local;
                local += p.length;
                embedded.push(f, p);
              }
          bytes = buildBinary(
            generation,
            pageEntries,
            encodeDocuments([]),
            0,
            embedded,
            index.avgBody,
            index.avgTitle,
          );
        } else if (kind === "documents")
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
  const localNorms = options.localTables
    ? new Uint8Array(index.count * 8)
    : new Uint8Array(0);
  if (options.localTables) {
    const v = new DataView(localNorms.buffer);
    for (let i = 0; i < index.count; i++) {
      const d = index.lengths(i);
      v.setUint32(i * 8, d.body, true);
      v.setUint32(i * 8 + 4, d.title, true);
    }
  }
  const ids = options.localTables
    ? encodeIds(index.count, (i) => index.document(i).id)
    : new Uint8Array(0);
  let hot = new Uint8Array(0),
    embeddedHotBytes = 0;
  if (options.hotDescriptors) {
    const weights = new Map<string, number>();
    for (const q of options.workload ?? [])
      for (const t of queryTerms(parse(q)))
        weights.set(t, (weights.get(t) ?? 0) + 1);
    const selected = [...entries]
      .sort(
        (a, b) =>
          (weights.get(b.term) ?? 0) - (weights.get(a.term) ?? 0) ||
          b.df - a.df ||
          (a.term < b.term ? -1 : 1),
      )
      .slice(0, options.hotDescriptors)
      .sort((a, b) => (a.term < b.term ? -1 : 1))
      .map((e) => ({ ...e }));
    const fixed =
      encodeRoot(root, localNorms, ids).length +
      buildBinary(
        generation,
        selected,
        encodeDocuments([]),
        0,
        [],
        index.avgBody,
        index.avgTitle,
      ).length;
    const streams = options.embedPostings
      ? selectStreams(
          selected,
          Math.max(0, budget - fixed - 1024),
          options.workload ?? [],
        )
      : { frequencies: new Set<string>(), positions: new Set<string>() };
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (const e of selected) {
      const f = streams.frequencies.has(e.term)
          ? await payload(e, false)
          : undefined,
        p = streams.positions.has(e.term) ? await payload(e, true) : undefined;
      if (f) {
        e.object = LOCAL;
        e.offset = offset;
        offset += f.length;
        chunks.push(f);
      }
      if (p) {
        e.positionObject = LOCAL;
        e.positionOffset = offset;
        offset += p.length;
        chunks.push(p);
      }
    }
    embeddedHotBytes = offset;
    hot = buildBinary(
      generation,
      selected,
      encodeDocuments([]),
      0,
      chunks,
      index.avgBody,
      index.avgTitle,
    );
  }
  const bundle = encodeRoot(root, localNorms, ids, hot);

  if (bundle.length > budget)
    throw Error("Paged bundle exceeds configured budget");
  await writeFile(join(out, "bundle.bin"), bundle);
  const manifest = {
    format: root.version,
    hotDescriptors: options.hotDescriptors ?? 0,
    embeddedHotBytes,
    inlineTiny: !!options.inlineTiny,
    localNormBytes: localNorms.length,
    localIdBytes: ids.length,
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
