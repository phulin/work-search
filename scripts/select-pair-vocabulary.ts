import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { decodeDirectoryBlock } from "../src/columnar/term-directory.js";
import { view } from "../src/columnar/format.js";
const [dir, sourceRoot] = process.argv.slice(2),
  limit = Number(process.argv[4] ?? 1024);
if (
  !dir ||
  !sourceRoot ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 1024
)
  throw Error(
    "Usage: select-pair-vocabulary.ts PACKET_DIR SOURCE_ROOT [MAX_TERMS<=1024]",
  );
const bytes = await readFile(dir + "/directory.bin"),
  data = view(bytes),
  root = JSON.parse(await readFile(sourceRoot, "utf8"));
if (data.getUint32(0, true) !== 0x32445443)
  throw Error("Invalid complete directory");
let ranked: {
    word: string;
    id: number;
    df: number;
    bodyOccurrences: number;
    titleOccurrences: number;
  }[] = [],
  seen = 0;
const prune = () => {
  ranked.sort(
    (a, b) =>
      b.df - a.df ||
      b.bodyOccurrences +
        b.titleOccurrences -
        (a.bodyOccurrences + a.titleOccurrences) ||
      a.id - b.id,
  );
  ranked.length = Math.min(ranked.length, limit);
};
for (let i = 0; i < data.getUint32(8, true); i++) {
  const p = 16 + i * 20,
    at = data.getUint32(p + 8, true),
    n = data.getUint32(p + 12, true),
    entries = decodeDirectoryBlock(
      gunzipSync(bytes.subarray(at, at + n)),
      root.count,
    );
  seen += entries.size;
  for (const [word, t] of entries)
    ranked.push({
      word,
      id: t.id,
      df: t.df,
      bodyOccurrences: t.bodyOccurrences,
      titleOccurrences: t.titleOccurrences,
    });
  if (ranked.length > limit + 4096) prune();
}
prune();
if (seen !== data.getUint32(4, true))
  throw Error("Directory term coverage mismatch");
const report = {
  corpusHash: root.corpusHash,
  documents: root.count,
  avgBody: root.avgBody,
  avgTitle: root.avgTitle,
  directorySha256: createHash("sha256").update(bytes).digest("hex"),
  termsSeen: seen,
  selection:
    "Highest corpus-wide document frequency; occurrence volume and numeric ID break ties; no query inputs",
  terms: ranked,
};
await writeFile(dir + "/pair-vocabulary.json", JSON.stringify(report));
console.log({
  termsSeen: seen,
  selected: ranked.length,
  minimumDF: ranked.at(-1)!.df,
  output: dir + "/pair-vocabulary.json",
});
