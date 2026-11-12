import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { BinaryIndex } from "../format/index.js";
import { tokenize } from "../query/tokenize.js";
import { jsonLines } from "../builder/jsonl.js";
import { sourceVerifier } from "./source-identity.js";
import { PagePacker } from "./pack.js";
import { CHUNK_TOKENS, encodeDictionary, type Root } from "./format.js";
import { encoder } from "../format/codec.js";
import {
  pairKey,
  encodePairDocs,
  encodePairRoot,
  encodePairEntry,
  type PairEntry,
  type PairRoot,
} from "./pairs.js";

export interface PairBuildOptions {
  input: string;
  source: string;
  base: string;
  out: string;
  budgetBytes?: number;
  vocabulary?: number;
  minDf?: number;
  inlineRarePairs?: boolean;
  maxRootBytes?: number;
}
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const varintBytes = (n: number) =>
  n < 128 ? 1 : n < 16384 ? 2 : n < 2097152 ? 3 : 4;
/** Two corpus passes. Fixed V² statistics, disk-spilled selected postings, bounded pack/dictionary buffers. */
export async function buildPairs(options: PairBuildOptions) {
  const started = performance.now(),
    budgetBytes = options.budgetBytes ?? 32 * 1048576,
    minDf = options.minDf ?? 100,
    vocabulary = options.vocabulary ?? 4096,
    inlineRarePairs = options.inlineRarePairs ?? false,
    dictionaryRawBytes = inlineRarePairs ? 131072 : 0,
    inlineMaxDf = 16;
  if (
    !Number.isInteger(vocabulary) ||
    vocabulary < 1 ||
    vocabulary > 4096 ||
    budgetBytes < 65536
  )
    throw Error("Invalid pair build budget/vocabulary");
  const sourceBytes = await readFile(options.source + "/bundle.bin"),
    sourceManifest = JSON.parse(
      await readFile(options.source + "/manifest.json", "utf8"),
    ),
    base: Root = JSON.parse(
      await readFile(options.base + "/root.json", "utf8"),
    ),
    baseManifest = JSON.parse(
      await readFile(options.base + "/manifest.json", "utf8"),
    ),
    sourceSha256 = hash(sourceBytes),
    index = new BinaryIndex(sourceBytes);
  if (sourceSha256 !== sourceManifest.bundleSha256)
    throw Error("Pair source checksum mismatch");
  // The original root generation commits to the source checksum and original packs.
  const expected = hash(
    JSON.stringify({
      version: 1,
      source: sourceSha256,
      objects: base.objects.slice(
        0,
        baseManifest.baseObjects ?? base.objects.length,
      ),
      pageBytes: base.pageBytes,
      chunkTokens: CHUNK_TOKENS,
    }),
  );
  if (expected !== base.generation || index.count !== base.count)
    throw Error("Pair source/base generation mismatch");
  const terms = Array.from({ length: index.termCount }, (_, i) =>
      index.entry(i),
    )
      .filter((e) => e.df >= minDf)
      .sort((a, b) => b.df - a.df || (a.term < b.term ? -1 : 1))
      .slice(0, vocabulary),
    ids = new Map(terms.map((e, i) => [e.term, i])),
    width = terms.length,
    df = new Uint32Array(width * width),
    last = new Uint32Array(width * width),
    costs = new Uint32Array(width * width),
    verifier = sourceVerifier(sourceManifest);
  let count = 0;
  function documentPairs(d: { body: string; title?: string }) {
    const pairs = new Set<number>();
    for (const field of [d.body, d.title ?? ""]) {
      const tokens = tokenize(field);
      for (let i = 1; i < tokens.length; i++) {
        const a = ids.get(tokens[i - 1]),
          b = ids.get(tokens[i]);
        if (a !== undefined && b !== undefined) pairs.add(a * width + b);
      }
    }
    return pairs;
  }
  for await (const line of jsonLines(options.input)) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    verifier.add(d);
    if (count >= index.count || d.id !== index.document(count).id)
      throw Error("Pair corpus ID mismatch");
    for (const pair of documentPairs(d)) {
      costs[pair] += varintBytes(count - (df[pair] ? last[pair] : 0));
      df[pair]++;
      last[pair] = count;
    }
    if (++count % 10000 === 0) console.log("Pair statistics", count);
  }
  verifier.verify(index.generation);
  if (count !== index.count) throw Error("Pair corpus count mismatch");
  const ranked: { pair: number; benefit: number; cost: number }[] = [];
  const selected = new Set<number>();
  let estimate = 65536,
    inlinePairs = 0,
    inlineDocuments = 0;
  for (let pair = 0; pair < df.length; pair++) {
    const a = Math.floor(pair / width),
      b = pair % width,
      upper = Math.min(terms[a].df, terms[b].df),
      cost = costs[pair] + 128 + terms[a].term.length + terms[b].term.length;
    if (inlineRarePairs && df[pair] > 0 && df[pair] <= inlineMaxDf) {
      selected.add(pair);
      inlinePairs++;
      inlineDocuments += df[pair];
      estimate +=
        costs[pair] + 12 + 2 * (terms[a].term.length + terms[b].term.length);
    } else if (df[pair] && df[pair] < upper)
      ranked.push({
        pair,
        benefit: (df[pair] * (upper - df[pair])) / cost,
        cost,
      });
  }
  ranked.sort((a, b) => b.benefit - a.benefit || a.pair - b.pair);
  if (estimate > budgetBytes * 0.85)
    throw Error(
      `All rare pairs need an estimated ${estimate} raw bytes before large-pair selection; increase storage budget`,
    );
  // Corpus pair DF proxies phrase opportunity; no query/workload observations enter ranking.
  // Predicted avoided unigram candidates per raw posting+descriptor byte, weighted by corpus opportunity.
  // Raw byte accounting reserves 15% for packing/root; the final compressed size is hard checked.
  for (const entry of ranked)
    if (estimate + entry.cost <= budgetBytes * 0.85) {
      selected.add(entry.pair);
      estimate += entry.cost;
    }
  await mkdir(options.out, { recursive: true });
  const db = new DatabaseSync(options.out + "/pairs.sqlite");
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; CREATE TABLE postings(pair INTEGER,doc INTEGER,PRIMARY KEY(pair,doc)) WITHOUT ROWID",
  );
  const insert = db.prepare("INSERT INTO postings VALUES(?,?)");
  count = 0;
  const secondVerifier = sourceVerifier(sourceManifest);
  db.exec("BEGIN");
  for await (const line of jsonLines(options.input)) {
    if (!line.trim()) continue;
    const document = JSON.parse(line);
    secondVerifier.add(document);
    if (count >= index.count || document.id !== index.document(count).id)
      throw Error("Pair second-pass corpus mismatch");
    for (const pair of documentPairs(document))
      if (selected.has(pair)) insert.run(pair, count);
    if (++count % 10000 === 0) {
      db.exec("COMMIT; BEGIN");
      console.log("Pair postings", count);
    }
  }
  db.exec("COMMIT");
  secondVerifier.verify(index.generation);
  if (count !== index.count) throw Error("Pair second-pass count mismatch");
  const packer = new PagePacker(options.out + "/packs", base.pageBytes),
    dictionary: Root["dictionary"] = [];
  await packer.start();
  let pending: [string, Uint8Array][] = [],
    pendingBytes = 0,
    stored = 0;
  const dictionaryLimit = dictionaryRawBytes || base.pageBytes * 0.6;
  const writeDictionary = async (
    entries: [string, Uint8Array][],
  ): Promise<void> => {
    const raw = encodeDictionary(entries);
    if (raw.length > dictionaryLimit && entries.length > 1) {
      const middle = entries.length >>> 1;
      await writeDictionary(entries.slice(0, middle));
      await writeDictionary(entries.slice(middle));
      return;
    }
    dictionary.push({
      first: entries[0][0],
      last: entries.at(-1)![0],
      address: await packer.put(raw, true),
    });
  };
  const flush = async () => {
    if (!pending.length) return;
    await writeDictionary(pending);
    pending = [];
    pendingBytes = 0;
  };
  const entries = [...selected]
    .map((pair) => ({
      pair,
      key: pairKey(
        terms[Math.floor(pair / width)].term,
        terms[pair % width].term,
      ),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const selectDocs = db.prepare(
    "SELECT doc FROM postings WHERE pair=? ORDER BY doc",
  );
  try {
    for (const { pair, key } of entries) {
      const entry: PairEntry = { df: df[pair], blocks: [] };
      let docs: number[] = [];
      const emit = async () => {
        if (!docs.length) return;
        const raw = encodePairDocs(docs);
        entry.blocks.push({
          first: docs[0],
          last: docs.at(-1)!,
          address: await packer.put(raw),
        });
        stored += gzipSync(raw, { level: 1 }).length;
        docs = [];
      };
      for (const row of selectDocs.iterate(pair) as Iterable<{ doc: number }>) {
        docs.push(row.doc);
        if (docs.length === 4096) await emit();
      }
      if (inlineRarePairs && entry.df <= inlineMaxDf) entry.inlineDocs = docs;
      else await emit();
      const value = inlineRarePairs
        ? encodePairEntry(entry)
        : encoder.encode(JSON.stringify(entry));
      if (pendingBytes + key.length * 3 + value.length + 12 > dictionaryLimit)
        await flush();
      pending.push([key, value]);
      pendingBytes += key.length * 3 + value.length + 12;
    }
    await flush();
    const objects = await packer.finish(),
      generation = hash(
        JSON.stringify({
          version: 1,
          base: base.generation,
          sourceSha256,
          objects,
          dictionary,
        }),
      ),
      root: Root = {
        version: 1,
        generation,
        count: base.count,
        avgBody: base.avgBody,
        avgTitle: base.avgTitle,
        pageBytes: base.pageBytes,
        objectPages: packer.objectBytes / base.pageBytes,
        dictionary,
        objects,
        hotBytes: 0,
      },
      manifest: PairRoot = {
        version: 1,
        baseGeneration: base.generation,
        sourceSha256,
        ...(inlineRarePairs ? { entryEncoding: "binary-v2" as const } : {}),
        root,
        selection: {
          vocabulary: width,
          pairs: selected.size,
          budgetBytes,
          minDf,
          ...(inlineRarePairs ? { inlineMaxDf } : {}),
        },
      },
      bytes = encodePairRoot(manifest),
      total = bytes.length + objects.reduce((n, o) => n + o.size, 0);
    if (bytes.length > (options.maxRootBytes ?? Infinity))
      throw Error(`Pair root budget exceeded: ${bytes.length}`);
    if (total > budgetBytes)
      throw Error(`Pair storage budget exceeded: ${total} > ${budgetBytes}`);
    await mkdir(options.out + "/packs/" + generation);
    for (const object of objects)
      await rename(
        options.out + "/packs/" + object.name,
        options.out + "/packs/" + generation + "/" + object.name,
      );
    await writeFile(options.out + "/pairs.bin", bytes);
    const result = {
      ...manifest.selection,
      generation,
      baseGeneration: base.generation,
      documents: count,
      rootBytes: bytes.length,
      totalBytes: total,
      postingBytes: stored,
      ...(inlineRarePairs
        ? {
            entryEncoding: "binary-v2",
            inlinePairs,
            inlineDocuments,
            dictionaryRawBytes,
          }
        : {}),
      ms: performance.now() - started,
      peakStatisticsBytes: df.byteLength + last.byteLength + costs.byteLength,
    };
    await writeFile(
      options.out + "/manifest.json",
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    db.close();
    await packer.abort();
  }
}
