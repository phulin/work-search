import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { benchmarkToken } from "./token.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import {
  encodeWords,
  assembleWords,
} from "../../src/columnar/word-directory.js";
import type { DirectoryBlock } from "../../src/columnar/term-directory.js";
import type { Root } from "../../src/columnar/format.js";
const [directory, out] = process.argv.slice(2);
if (!out) throw Error("Use SOURCE_BUILD OUTPUT_DIRECTORY");
await mkdir(out, { recursive: true });
const state = JSON.parse(await readFile(directory + "/build.json", "utf8")),
  token = await benchmarkToken(),
  uploader = "https://work-search-cws-upload.phulin.workers.dev",
  response = await fetch(uploader + "/" + state.rootRef.key, {
    headers: { authorization: `Bearer ${token}` },
  });
if (!response.ok) throw Error("Vocabulary root " + response.status);
const bytes = new Uint8Array(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== state.rootRef.sha256)
  throw Error("Vocabulary root digest mismatch");
const root = JSON.parse(new TextDecoder().decode(bytes)),
  source = new OfflineObjects(directory, root, { url: uploader, token }),
  leaves: Root["dictionaries"] = [],
  variants = [256, 512, 1024, 2048].map((size) => ({
    size,
    pending: [] as string[],
    blocks: [] as DirectoryBlock[],
    rawBytes: 0,
  })),
  started = performance.now();
let count = 0,
  previous: string | undefined;
async function visit(fences: Root["dictionaries"], height: number) {
  for (const fence of fences)
    if (height)
      await visit(
        JSON.parse(new TextDecoder().decode(await source.read(fence.ref))),
        height - 1,
      );
    else leaves.push(fence);
}
function flush(v: (typeof variants)[number]) {
  if (!v.pending.length) return;
  const raw = encodeWords(v.pending);
  v.blocks.push({
    first: v.pending[0],
    count: v.pending.length,
    data: raw,
  });
  v.rawBytes += raw.length;
  v.pending = [];
}
try {
  await visit(
    root.idRouting.dictionaries,
    root.idRouting.dictionaryHeight ?? 0,
  );
  for (let i = 0; i < leaves.length; i += 8) {
    const batch = await Promise.all(
      leaves
        .slice(i, i + 8)
        .map(
          async (fence) =>
            JSON.parse(
              new TextDecoder().decode(await source.read(fence.ref)),
            ) as [string, number][],
        ),
    );
    for (const entries of batch)
      for (const [word, id] of entries) {
        if (id !== count + 1 || (previous !== undefined && previous >= word))
          throw Error("Nonordinal native vocabulary");
        count++;
        previous = word;
        for (const v of variants) {
          v.pending.push(word);
          if (v.pending.length === v.size) flush(v);
        }
      }
    if (i % 512 === 0)
      console.log("Word directory", i, "/", leaves.length, count);
  }
  if (count !== state.terms) throw Error("Incomplete native vocabulary");
  const results = [];
  for (const v of variants) {
    flush(v);
    const data = assembleWords(v.blocks),
      sha256 = createHash("sha256").update(data).digest("hex");
    await writeFile(out + `/words-${v.size}.bin`, data);
    results.push({
      blockSize: v.size,
      bytes: data.length,
      rawBytes: v.rawBytes,
      blocks: v.blocks.length,
      sha256,
    });
  }
  const result = {
    count,
    sourceDocuments: state.count,
    sourceRoot: state.rootRef,
    elapsedMs: performance.now() - started,
    variants: results,
    note: "Complete native constructor word-to-ID directory. Every source ID and lexical ordinal validated. This does not contain serving posting metadata.",
  };
  await writeFile(out + "/manifest.json", JSON.stringify(result, null, 2));
  console.log(result);
} finally {
  await source.close();
}
