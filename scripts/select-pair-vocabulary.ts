import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TermDirectory } from "../src/columnar/term-directory.js";
const [dir, sourceRoot] = process.argv.slice(2),
  limit = Number(process.argv[4] ?? 65536);
if (
  !dir ||
  !sourceRoot ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 65536
)
  throw Error(
    "Usage: select-pair-vocabulary.ts PACKET_DIR SOURCE_ROOT [MAX_TERMS<=65536]",
  );
const bytes = await readFile(dir + "/directory.bin"),
  root = JSON.parse(await readFile(sourceRoot, "utf8")),
  directory = new TermDirectory(bytes, root.count);
if (directory.bundledTerms < Math.min(directory.terms, limit))
  throw Error("Pair vocabulary exceeds the bundled common tier");
let ranked: {
    word: string;
    id: number;
    df: number;
    bodyOccurrences: number;
    titleOccurrences: number;
  }[] = [],
  seen = 0;
const prune = () => {
  ranked.sort((a, b) => b.df - a.df || a.id - b.id);
  ranked.length = Math.min(ranked.length, limit);
};
for await (const [word, t] of directory.bundledEntries()) {
  seen++;
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
if (seen !== directory.bundledTerms)
  throw Error("Directory term coverage mismatch");
const report = {
  corpusHash: root.corpusHash,
  analysis: root.analysis,
  documents: root.count,
  avgBody: root.avgBody,
  avgTitle: root.avgTitle,
  directorySha256: createHash("sha256").update(bytes).digest("hex"),
  termsSeen: seen,
  selection:
    "Highest corpus-wide document frequency; numeric ID breaks ties, matching the bundled tier; no query inputs",
  terms: ranked,
};
await writeFile(dir + "/pair-vocabulary.json", JSON.stringify(report));
console.log({
  termsSeen: seen,
  selected: ranked.length,
  minimumDF: ranked.at(-1)!.df,
  output: dir + "/pair-vocabulary.json",
});
