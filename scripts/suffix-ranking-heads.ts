import { open, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SuffixManifest, SuffixBlock } from "../src/suffix/format.js";
import { encodeRankingHeads } from "../src/suffix/ranking-heads.js";

const [directory] = process.argv.slice(2);
if (!directory) throw Error("Use SUFFIX_DIRECTORY");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest-max.json", "utf8").catch(() =>
      readFile(directory + "/manifest.json", "utf8"),
    ),
  ),
  baseGeneration = manifest.generation,
  saved = await readFile(directory + "/ranking-construction.json", "utf8").then(
    JSON.parse,
    () => undefined,
  ),
  columns = [
    "documents",
    "positions",
    "flags",
    ...Array.from({ length: 4 }, (_, i) => `score16-${i + 2}`),
  ],
  handles = new Map(
    await Promise.all(
      ["directory", ...columns].map(
        async (f) => [f, await open(directory + "/" + f, "r")] as const,
      ),
    ),
  ),
  output = await open(directory + "/ranking", saved ? "r+" : "w");
if (saved && saved.baseGeneration !== baseGeneration)
  throw Error("Suffix ranking source generation changed");
let offset = saved?.offset ?? 0,
  next = saved?.next ?? 0;
await output.truncate(offset);
for (let i = 0; i < next; i++) manifest.directory[i].ranking = saved.ranking[i];
const started = Date.now();
try {
  for (; next < manifest.directory.length; next++) {
    const group = manifest.directory[next],
      compressed = Buffer.allocUnsafe(group.ref.length);
    if (
      (
        await handles
          .get("directory")!
          .read(compressed, 0, compressed.length, group.ref.offset)
      ).bytesRead !== compressed.length
    )
      throw Error("Truncated suffix directory");
    const blocks: SuffixBlock[] = JSON.parse(gunzipSync(compressed).toString()),
      arrays = await Promise.all(
        columns.map(async (name) => {
          const refs = blocks.map(
              (b) => b.columns[name as keyof typeof b.columns],
            ),
            first = refs[0].offset,
            end = refs.at(-1)!.offset + refs.at(-1)!.length;
          for (let i = 1; i < refs.length; i++)
            if (refs[i].offset !== refs[i - 1].offset + refs[i - 1].length)
              throw Error("Noncontiguous suffix column");
          const raw = Buffer.allocUnsafe(end - first);
          if (
            (await handles.get(name)!.read(raw, 0, raw.length, first))
              .bytesRead !== raw.length
          )
            throw Error("Truncated suffix column");
          const decoded = gunzipSync(raw),
            width = name === "documents" || name === "positions" ? 4 : 2;
          if (decoded.length !== (group.end - group.first) * width)
            throw Error("Suffix column coverage mismatch");
          return decoded;
        }),
      ),
      u32 = (b: Buffer) =>
        new Uint32Array(b.buffer, b.byteOffset, b.length / 4),
      u16 = (b: Buffer) =>
        new Uint16Array(b.buffer, b.byteOffset, b.length / 2),
      packets = encodeRankingHeads(
        blocks,
        u32(arrays[0]),
        u32(arrays[1]),
        u16(arrays[2]),
        arrays.slice(3).map(u16),
      );
    group.ranking = {};
    for (let p = 0; p < 4; p++) {
      const raw = gzipSync(packets[p], { level: 1 });
      await output.write(raw, 0, raw.length, offset);
      group.ranking[p + 2] = { offset, length: raw.length };
      offset += raw.length;
    }
    if ((next + 1) % 16 === 0 || next + 1 === manifest.directory.length) {
      await writeFile(
        directory + "/ranking-construction.json.tmp",
        JSON.stringify({
          baseGeneration,
          next: next + 1,
          offset,
          ranking: manifest.directory.slice(0, next + 1).map((g) => g.ranking),
        }),
      );
      await rename(
        directory + "/ranking-construction.json.tmp",
        directory + "/ranking-construction.json",
      );
      console.log(
        JSON.stringify({
          groups: next + 1,
          total: manifest.directory.length,
          rows: group.end,
          bytes: offset,
          seconds: (Date.now() - started) / 1000,
          rss: process.memoryUsage().rss,
        }),
      );
    }
  }
} finally {
  await output.close();
  await Promise.all([...handles.values()].map((h) => h.close()));
}
const hash = createHash("sha256");
for await (const b of createReadStream(directory + "/ranking")) hash.update(b);
manifest.files.ranking = {
  bytes: (await stat(directory + "/ranking")).size,
  sha256: hash.digest("hex"),
};
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(directory + "/manifest-heads.json", JSON.stringify(manifest));
console.log(
  JSON.stringify({
    generation: manifest.generation,
    groups: next,
    bytes: manifest.files.ranking.bytes,
    milliseconds: Date.now() - started,
  }),
);
