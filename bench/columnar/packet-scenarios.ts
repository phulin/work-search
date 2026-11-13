import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { decodeDirectoryBlock } from "../../src/columnar/term-directory.js";
import { view } from "../../src/columnar/format.js";

const [dir, out] = process.argv.slice(2);
if (!out) throw Error("Usage: packet-scenarios.ts PACKET_DIR OUTPUT.json");
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  bytes = await readFile(dir + "/directory.bin"),
  data = view(bytes),
  bounds = [1, 4, 16, 64, 128, 256, 400, 512, 1024, 4096, 16384, 65536],
  buckets = bounds.map(() => [] as { word: string; df: number }[]),
  seen = bounds.map(() => 0);
let seed = 20261113;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}
for (let i = 0; i < data.getUint32(8, true); i++) {
  const at = 16 + i * 20,
    start = data.getUint32(at + 8, true),
    n = data.getUint32(at + 12, true);
  for (const [word, term] of decodeDirectoryBlock(
    gunzipSync(bytes.subarray(start, start + n)),
    root.count,
  )) {
    if (!/^[a-z]{5,18}$/.test(word)) continue;
    const bin = bounds.findIndex(
      (lower, j) => term.df >= lower && term.df < (bounds[j + 1] ?? 131072),
    );
    if (bin < 0) continue;
    const count = ++seen[bin],
      chosen = Math.floor(random() * count);
    if (buckets[bin].length < 2) buckets[bin].push({ word, df: term.df });
    else if (chosen < 2) buckets[bin][chosen] = { word, df: term.df };
  }
}
// Vocabulary sampling is independent of index accelerators. These held-out
// contracts deliberately exercise the transfer/candidate budget boundaries.
const scenarios = buckets.flatMap((bucket, bin) =>
  bucket.flatMap(({ word, df }) => [
    { q: word, kind: "packet-frequency", dfBin: bounds[bin], anchorDf: df },
    {
      q: `${word} AND court`,
      kind: "packet-common-intersection",
      dfBin: bounds[bin],
      anchorDf: df,
    },
    {
      q: `${word} AND summary`,
      kind: "packet-term-intersection",
      dfBin: bounds[bin],
      anchorDf: df,
    },
    {
      q: `${word} /5 summary`,
      kind: "packet-proximity",
      dfBin: bounds[bin],
      anchorDf: df,
    },
    {
      q: `"${word} of"`,
      kind: "packet-sparse-phrase",
      dfBin: bounds[bin],
      anchorDf: df,
    },
  ]),
);
await writeFile(out, JSON.stringify(scenarios, null, 2));
console.log({
  corpusHash: root.corpusHash,
  seed: 20261113,
  vocabularyBuckets: buckets,
  scenarios: scenarios.length,
});
