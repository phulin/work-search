import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { tokenize } from "../src/query/tokenize.js";
import { jsonLines } from "../src/builder/jsonl.js";
const [input, source, out, v = "4096"] = process.argv.slice(2);
if (!out)
  throw Error(
    "Usage: analyze-pair-statistics INPUT SOURCE OUTPUT_JSON [VOCABULARY]",
  );
const index = new BinaryIndex(await readFile(source + "/bundle.bin")),
  terms = Array.from({ length: index.termCount }, (_, i) => index.entry(i))
    .filter((e) => e.df >= 100)
    .sort((a, b) => b.df - a.df || (a.term < b.term ? -1 : 1))
    .slice(0, Number(v)),
  ids = new Map(terms.map((e, i) => [e.term, i])),
  width = terms.length,
  df = new Uint32Array(width * width),
  last = new Uint32Array(width * width),
  costs = new Uint32Array(width * width);
let count = 0,
  adjacencies = 0,
  eligibleAdjacencies = 0;
for await (const line of jsonLines(input)) {
  if (!line.trim()) continue;
  const document = JSON.parse(line),
    pairs = new Set<number>();
  for (const field of [document.body, document.title ?? ""]) {
    const tokens = tokenize(field);
    adjacencies += Math.max(0, tokens.length - 1);
    for (let i = 1; i < tokens.length; i++) {
      const a = ids.get(tokens[i - 1]),
        b = ids.get(tokens[i]);
      if (a !== undefined && b !== undefined) {
        pairs.add(a * width + b);
        eligibleAdjacencies++;
      }
    }
  }
  for (const pair of pairs) {
    const gap = count - (df[pair] ? last[pair] : 0);
    costs[pair] += gap < 128 ? 1 : gap < 16384 ? 2 : gap < 2097152 ? 3 : 4;
    df[pair]++;
    last[pair] = count;
  }
  if (++count % 10000 === 0) console.log("Pair coverage", count);
}
let observedPairs = 0,
  eligibleSelectivePairs = 0,
  pairDocuments = 0,
  rawVarintBytes = 0,
  estimatedSelectiveBytes = 0;
for (let pair = 0; pair < df.length; pair++)
  if (df[pair]) {
    observedPairs++;
    pairDocuments += df[pair];
    rawVarintBytes += costs[pair];
    const a = Math.floor(pair / width),
      b = pair % width;
    if (df[pair] < Math.min(terms[a].df, terms[b].df)) {
      eligibleSelectivePairs++;
      estimatedSelectiveBytes +=
        costs[pair] + 128 + terms[a].term.length + terms[b].term.length;
    }
  }
const result = {
  documents: count,
  vocabulary: width,
  minVocabularyDf: terms.at(-1)?.df,
  observedPairs,
  eligibleSelectivePairs,
  pairDocuments,
  rawVarintBytes,
  estimatedSelectiveBytes,
  adjacencies,
  eligibleAdjacencies,
  adjacencyOccurrenceCoverage: eligibleAdjacencies / adjacencies,
};
await writeFile(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
