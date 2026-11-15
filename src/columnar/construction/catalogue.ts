import { BuildStore, digest, jsonBytes, type Chunk } from "./runs.js";
import {
  SummaryReader,
  type SummaryRun,
  type SummaryCursor,
} from "./term-summaries.js";
import { assembleWords, encodeWords } from "../word-directory.js";
import type { WordPacket } from "./word-lookup.js";
import { u32 } from "../format.js";
import type { Analysis } from "../../query/analysis.js";

export interface Catalogue {
  format: "construction-catalogue-v3";
  source: string;
  analysis?: Analysis;
  documents: number;
  bodyTokens: number;
  titleTokens: number;
  terms: number;
  partitions: { firstId: number; count: number; summaries: SummaryRun }[];
  words: WordPacket[];
  hot: { count: number; df: number; lastId: number };
  pairTerms: {
    word: string;
    id: number;
    df: number;
    bodyOccurrences?: number;
    titleOccurrences?: number;
  }[];
  common?: { first: string; count: number; words: Chunk; ids: Chunk }[];
  commonBundle?: { hot: Chunk; ids: Chunk };
}
export interface CatalogueState {
  version: 3;
  cursor: SummaryCursor;
  nextId: number;
  hotTies?: number;
  pairTies?: number;
  done?: boolean;
}
/** The coordinator prefix-sums unique counts, then each lexical partition can
 * produce exact IDs independently. No positional payload or document is read. */
export async function cataloguePartition(
  store: BuildStore,
  run: SummaryRun,
  firstId: number,
  saved?: CatalogueState,
  termBudget = 65536,
  selections?: {
    hot: { df: number; ties: number };
    pair: { df: number; ties: number };
  },
) {
  if (
    run.version !== 3 ||
    firstId < 1 ||
    !Number.isInteger(firstId) ||
    (saved && saved.version !== 3)
  )
    throw Error("Invalid catalogue partition");
  const state: CatalogueState = saved
    ? structuredClone(saved)
    : { version: 3, cursor: { chunk: 0, row: 0 }, nextId: firstId };
  const reader = new SummaryReader(store, run, state.cursor),
    packets: WordPacket[] = [];
  const common: NonNullable<Catalogue["common"]> = [],
    pairTerms: Catalogue["pairTerms"] = [];
  let words: string[] = [],
    count = 0,
    hotWords: string[] = [],
    hotIds: number[] = [],
    lastHotTie = 0;
  let blocks: { first: string; count: number; data: Uint8Array }[] = [],
    packetBytes = 0,
    packetFirstId = state.nextId;
  const flushPacket = async () => {
    if (!blocks.length) return;
    const raw = assembleWords(blocks),
      n = blocks.reduce((n, b) => n + b.count, 0);
    packets.push({
      first: blocks[0].first,
      last: packetLast!,
      firstId: packetFirstId,
      count: n,
      ref: await store.put(raw, "plan-0.bin"),
    });
    blocks = [];
    packetBytes = 0;
    packetFirstId += n;
  };
  let packetLast: string | undefined;
  const flush = async () => {
    if (!words.length) return;
    const data = encodeWords(words);
    if (packetBytes && packetBytes + data.length > 256 * 1024)
      await flushPacket();
    blocks.push({ first: words[0], count: words.length, data });
    packetBytes += data.length;
    packetLast = words.at(-1);
    words = [];
  };
  const flushCommon = async () => {
    if (!hotWords.length) return;
    const refs = await store.putParts([encodeWords(hotWords), u32(hotIds)]);
    common.push({
      first: hotWords[0],
      count: hotWords.length,
      words: refs[0],
      ids: refs[1],
    });
    hotWords = [];
    hotIds = [];
  };
  for (;;) {
    const row = await reader.peek();
    if (!row) {
      state.done = true;
      break;
    }
    if (count >= termBudget) break;
    const id = state.nextId;
    if (selections) {
      const h = selections.hot,
        p = selections.pair;
      const isHot =
        row.df > h.df || (row.df === h.df && (state.hotTies ?? 0) < h.ties);
      if (row.df === h.df) state.hotTies = (state.hotTies ?? 0) + 1;
      if (isHot) {
        hotWords.push(row.word);
        hotIds.push(id);
        if (row.df === h.df) lastHotTie = id;
      }
      const isPair =
        row.df > p.df || (row.df === p.df && (state.pairTies ?? 0) < p.ties);
      if (row.df === p.df) state.pairTies = (state.pairTies ?? 0) + 1;
      if (isPair)
        pairTerms.push({
          word: row.word,
          id,
          df: row.df,
          bodyOccurrences: row.body,
          titleOccurrences: row.title,
        });
    }
    words.push(row.word);
    state.nextId++;
    count++;
    reader.consume();
    if (words.length === 4096) await flush();
    if (hotWords.length === 4096) await flushCommon();
  }
  await flush();
  await flushPacket();
  await flushCommon();
  state.cursor = reader.cursor;
  return { state, packets, common, pairTerms, lastHotTie, count };
}
/** Global selection uses DF descending, lexical-ID ascending. Bounded heaps in
 * the coordinator need at most requested candidates, never the whole vocabulary. */
export function selectionThreshold(
  histogram: [number, number][],
  limit: number,
) {
  let count = 0;
  for (const [df, terms] of histogram.slice().sort((a, b) => b[0] - a[0])) {
    if (count + terms >= limit) return { df, ties: limit - count };
    count += terms;
  }
  return { df: 0, ties: 0 };
}
export async function validateCatalogue(
  store: BuildStore,
  catalogue: Catalogue,
) {
  if (
    catalogue.format !== "construction-catalogue-v3" ||
    !/^[a-f0-9]{64}$/.test(catalogue.source) ||
    catalogue.documents < 1
  )
    throw Error("Invalid catalogue identity");
  let next = 1;
  for (const p of catalogue.partitions) {
    if (
      p.firstId !== next ||
      p.summaries.first !== 0 ||
      p.summaries.end !== catalogue.documents ||
      p.summaries.version !== 3
    )
      throw Error("Catalogue partition coverage mismatch");
    next += p.count;
  }
  if (next !== catalogue.terms + 1)
    throw Error("Catalogue term coverage mismatch");
  next = 1;
  for (const [i, p] of catalogue.words.entries()) {
    if (
      p.firstId !== next ||
      p.count < 1 ||
      (i && catalogue.words[i - 1].last >= p.first)
    )
      throw Error("Catalogue word coverage mismatch");
    next += p.count;
  }
  if (next !== catalogue.terms + 1)
    throw Error("Catalogue dictionary coverage mismatch");
  return {
    ref: await store.put(jsonBytes(catalogue), "plan-0.bin"),
    identity: await digest(jsonBytes(catalogue)),
  };
}
