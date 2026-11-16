import { open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  encodePhraseIntervals,
  type PhraseInterval,
} from "../src/suffix/intervals.js";
import { SuffixFences } from "../src/suffix/fences.js";
import { decodeSuffixKeys, comparePhrase } from "../src/suffix/keys.js";
import { Lru } from "../src/columnar/storage.js";
import type { SuffixManifest, SuffixBlock } from "../src/suffix/format.js";

const [directory] = process.argv.slice(2),
  limit = Number(process.env.CWS_SUFFIX_INTERVAL_COUNT ?? 65536);
if (!directory || !Number.isInteger(limit) || limit < 1)
  throw Error("Use SUFFIX_DIRECTORY; optional CWS_SUFFIX_INTERVAL_COUNT");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest-fences.json", "utf8"),
  ),
  fences = new SuffixFences(await readFile(directory + "/fences"), manifest),
  input = await open(directory + "/directory", "r"),
  keys = await open(directory + "/keys", "r"),
  started = Date.now(),
  runs: Array<{ words: number[]; count: number } | undefined> = [],
  heap: Array<{ words: number[]; count: number }> = [];
const cmp = (a: (typeof heap)[number], b: (typeof heap)[number]) =>
  a.count - b.count ||
  a.words.length - b.words.length ||
  a.words.reduce((n, w, i) => n || w - (b.words[i] ?? 0), 0);
function keep(run: (typeof heap)[number]) {
  if (heap.length < limit) {
    let i = heap.push(run) - 1;
    while (i) {
      const p = (i - 1) >>> 1;
      if (cmp(heap[i], heap[p]) >= 0) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
    return;
  }
  if (cmp(run, heap[0]) <= 0) return;
  heap[0] = run;
  let i = 0;
  while (i * 2 + 1 < heap.length) {
    let c = i * 2 + 1;
    if (c + 1 < heap.length && cmp(heap[c + 1], heap[c]) < 0) c++;
    if (cmp(heap[c], heap[i]) >= 0) break;
    [heap[c], heap[i]] = [heap[i], heap[c]];
    i = c;
  }
}
try {
  for (const group of manifest.directory) {
    const compressed = Buffer.allocUnsafe(group.ref.length);
    if (
      (await input.read(compressed, 0, compressed.length, group.ref.offset))
        .bytesRead !== compressed.length
    )
      throw Error("Truncated suffix directory");
    const blocks: SuffixBlock[] = JSON.parse(gunzipSync(compressed).toString());
    for (const block of blocks)
      for (let n = 2; n <= 5; n++) {
        const words = block.low.slice(0, n),
          complete =
            words.length === n &&
            !words.some((w) => !w) &&
            comparePhrase(block.high, words) === 0,
          run = runs[n];
        if (run && (!complete || comparePhrase(run.words, words) !== 0)) {
          keep(run);
          runs[n] = undefined;
        }
        if (complete) {
          if (runs[n]) runs[n]!.count += block.count;
          else runs[n] = { words, count: block.count };
        }
      }
  }
  for (const run of runs) if (run) keep(run);
} finally {
  await input.close();
}
const cache = new Lru<Uint32Array>(64 * 1048576);
let keyReads = 0,
  keyBytes = 0;
async function boundary(
  block: SuffixBlock,
  phrase: Uint32Array,
  upper: boolean,
) {
  if (!upper && comparePhrase(block.low, phrase) === 0) return block.first;
  const ref = block.columns.keys,
    key = String(ref.offset);
  let data = cache.get(key);
  if (!data) {
    const raw = Buffer.allocUnsafe(ref.length);
    if (
      (await keys.read(raw, 0, raw.length, ref.offset)).bytesRead !== raw.length
    )
      throw Error("Truncated suffix keys");
    data = decodeSuffixKeys(gunzipSync(raw), block.count);
    cache.set(key, data, data.byteLength);
    keyReads++;
    keyBytes += raw.length;
  }
  let lo = 0,
    hi = block.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1,
      cmp = comparePhrase(data.subarray(mid * 8, mid * 8 + 8), phrase);
    if (cmp < 0 || (upper && cmp === 0)) lo = mid + 1;
    else hi = mid;
  }
  return block.first + lo;
}
// Lexical processing reuses neighboring key blocks; selected phrases depend
// only on complete-block occurrence volume, never on benchmark query strings.
heap.sort((a, b) => {
  for (let i = 0; i < Math.min(a.words.length, b.words.length); i++)
    if (a.words[i] !== b.words[i]) return a.words[i] - b.words[i];
  return a.words.length - b.words.length;
});
const intervals: PhraseInterval[] = [];
try {
  for (const [i, run] of heap.entries()) {
    const phrase = Uint32Array.from(run.words),
      [left, right] = fences.bounds(phrase)!,
      first = await boundary(left, phrase, false),
      end = await boundary(right, phrase, true);
    if (end - first < run.count)
      throw Error("Suffix interval omits complete rows");
    intervals.push({ words: run.words, first, end });
    if ((i + 1) % 4096 === 0)
      console.log(
        JSON.stringify({
          done: i + 1,
          total: heap.length,
          keyReads,
          keyBytes,
          seconds: (Date.now() - started) / 1000,
        }),
      );
  }
} finally {
  await keys.close();
}
const raw = encodePhraseIntervals(
  intervals,
  manifest.corpusGeneration,
  manifest.rows,
);
await writeFile(directory + "/intervals", raw);
manifest.files.intervals = {
  bytes: raw.length,
  sha256: createHash("sha256").update(raw).digest("hex"),
};
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(
  directory + "/manifest-intervals.json",
  JSON.stringify(manifest),
);
console.log(
  JSON.stringify({
    generation: manifest.generation,
    intervals: intervals.length,
    bytes: raw.length,
    keyReads,
    keyBytes,
    milliseconds: Date.now() - started,
    rss: process.memoryUsage().rss,
  }),
);
