import { open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PhraseIntervals } from "../src/suffix/intervals.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { Lru } from "../src/columnar/storage.js";
import {
  encodePhraseRanks,
  phraseRankDirectory,
  type PhraseRankRecord,
} from "../src/suffix/phrase-ranks.js";
import type { SuffixManifest } from "../src/suffix/format.js";
import { collectPhraseRanking } from "./suffix-phrase-ranking.js";

const [directory, countText = "65536", inlineText = "4096"] =
    process.argv.slice(2),
  count = Number(countText),
  inlineCount = Number(inlineText);
if (
  !directory ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 65536 ||
  !Number.isInteger(inlineCount) ||
  inlineCount < 0 ||
  inlineCount > count
)
  throw Error("Use SUFFIX_DIRECTORY [PHRASE_COUNT] [BUNDLED_PHRASE_COUNT]");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest-intervals.json", "utf8"),
  ),
  fences = await readFile(directory + "/" + (manifest.fences ?? "fences")),
  intervals = await readFile(directory + "/intervals"),
  candidates = [
    ...new PhraseIntervals(
      intervals,
      manifest.corpusGeneration,
      manifest.rows,
    ).entries(),
  ]
    .sort(
      (a, b) =>
        b.end - b.first - (a.end - a.first) ||
        a.first - b.first ||
        a.words.length - b.words.length,
    )
    .slice(0, count)
    .sort((a, b) => a.first - b.first || a.words.length - b.words.length),
  handles = new Map<string, ReturnType<typeof open>>(),
  cache = new Lru<Uint8Array>(64 * 1048576),
  records: PhraseRankRecord[] = [],
  intervalDirectory = new PhraseIntervals(
    intervals,
    manifest.corpusGeneration,
    manifest.rows,
  ),
  started = Date.now();
let reads = 0,
  bytes = 0,
  usable = 0;
try {
  for (const phrase of candidates) {
    const reader = new SuffixReader(
        manifest,
        async (file, offset, length) => {
          const key = `${file}:${offset}:${length}`,
            hit = cache.get(key);
          if (hit) return hit;
          let pending = handles.get(file);
          if (!pending)
            handles.set(file, (pending = open(directory + "/" + file, "r")));
          const handle = await pending;
          const raw = Buffer.allocUnsafe(length);
          if ((await handle.read(raw, 0, length, offset)).bytesRead !== length)
            throw Error("Truncated suffix construction input");
          cache.set(key, raw, raw.length);
          reads++;
          bytes += raw.length;
          return raw;
        },
        fences,
        { intervals, rankingLookahead: 1 },
      ),
      record = await collectPhraseRanking(
        reader,
        Uint32Array.from(phrase.words),
      );
    if (record.entries.length) {
      records.push(record);
      const sorted = record.entries.slice().sort((a, b) => b.lower - a.lower);
      if (sorted.length >= 20 && record.tailUpper < sorted[19].lower) usable++;
    }
    if (records.length % 32 === 0 || records.length === candidates.length)
      console.log(
        JSON.stringify({
          done: records.length,
          total: candidates.length,
          usableAt20: usable,
          reads,
          bytes,
          seconds: (Date.now() - started) / 1000,
          rss: process.memoryUsage().rss,
        }),
      );
  }
} finally {
  await Promise.all([...handles.values()].map(async (h) => (await h).close()));
}
const raw = encodePhraseRanks(
  records,
  manifest.corpusGeneration,
  manifest.rows,
);
const save = async (label: string, bytes: Uint8Array) => {
  const sha256 = createHash("sha256").update(bytes).digest("hex"),
    name = label + "-" + sha256.slice(0, 16);
  await writeFile(directory + "/" + name, bytes);
  manifest.files[name] = { bytes: bytes.length, sha256 };
  return name;
};
manifest.phraseRankRows = await save("phrase-rank-rows", raw);
const index = phraseRankDirectory(raw);
manifest.phraseRankIndex = await save("phrase-rank-index", index);
const hot = records
    .slice()
    .sort((a, b) => {
      const x = intervalDirectory.lookup(Uint32Array.from(a.words))!,
        y = intervalDirectory.lookup(Uint32Array.from(b.words))!;
      return (
        y.end - y.first - (x.end - x.first) ||
        x.first - y.first ||
        a.words.length - b.words.length
      );
    })
    .slice(0, inlineCount),
  inline = encodePhraseRanks(hot, manifest.corpusGeneration, manifest.rows);
manifest.phraseRanks = await save("phrase-ranks", inline);
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(
  directory + `/manifest-phrase-ranks-${count}-inline-${inlineCount}.json`,
  JSON.stringify(manifest),
);
console.log(
  JSON.stringify({
    generation: manifest.generation,
    records: records.length,
    usableAt20: usable,
    bytes: raw.length,
    directoryBytes: index.length,
    bundledRankingBytes: index.length + inline.length,
    inlineCount,
    seconds: (Date.now() - started) / 1000,
  }),
);
