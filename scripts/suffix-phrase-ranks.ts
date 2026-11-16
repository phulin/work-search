import { open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PhraseIntervals } from "../src/suffix/intervals.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { Lru } from "../src/columnar/storage.js";
import {
  encodePhraseRanks,
  type PhraseRankRecord,
} from "../src/suffix/phrase-ranks.js";
import type { SuffixManifest } from "../src/suffix/format.js";
import { collectPhraseRanking } from "./suffix-phrase-ranking.js";

const [directory, countText = "4096"] = process.argv.slice(2),
  count = Number(countText);
if (!directory || !Number.isInteger(count) || count < 1 || count > 65536)
  throw Error("Use SUFFIX_DIRECTORY [PHRASE_COUNT]");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest-intervals.json", "utf8"),
  ),
  fences = await readFile(directory + "/fences"),
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
  ),
  sha256 = createHash("sha256").update(raw).digest("hex"),
  name = `phrase-ranks-${sha256.slice(0, 16)}`;
await writeFile(directory + "/" + name, raw);
manifest.files[name] = { bytes: raw.length, sha256 };
manifest.phraseRanks = name;
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(
  directory + `/manifest-phrase-ranks-${count}.json`,
  JSON.stringify(manifest),
);
console.log(
  JSON.stringify({
    generation: manifest.generation,
    records: records.length,
    usableAt20: usable,
    bytes: raw.length,
    seconds: (Date.now() - started) / 1000,
  }),
);
