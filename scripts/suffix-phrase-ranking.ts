import { Heap } from "../src/columnar/top-k.js";
import {
  canonicalBit,
  scoreInterval,
  quantizerForMaximum,
} from "../src/suffix/format.js";
import type { SuffixBlock, SuffixColumn } from "../src/suffix/format.js";
import type { SuffixReader } from "../src/suffix/reader.js";
import type { PhraseRankRecord } from "../src/suffix/phrase-ranks.js";

/** Corpus-only construction from the same conservative scan as serving. Every
 * skipped block and rejected row contributes to the bound on omitted scores. */
export async function collectPhraseRanking(
  reader: SuffixReader,
  words: Uint32Array,
  limit = 32,
): Promise<PhraseRankRecord> {
  const heap = new Heap(limit),
    kept = new Map<
      number,
      {
        block: SuffixBlock;
        row: number;
        lower: number;
        upper: number;
        doc?: number;
        position?: number;
      }
    >(),
    column = `score16-${words.length}` as SuffixColumn,
    bit = canonicalBit(words.length, "all");
  let tailUpper = 0;
  const admit = (maximum: number) => {
    const upper = maximum + 128 * Number.EPSILON * Math.max(1, maximum);
    if (upper >= (heap.threshold?.score ?? 0)) return true;
    tailUpper = Math.max(tailUpper, upper);
    return false;
  };
  for await (const batch of reader.rankedScan(
    words,
    ["flags", column],
    admit,
  )) {
    const view = (name: SuffixColumn) => {
        const raw = batch.columns[name];
        return raw
          ? new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
          : undefined;
      },
      flags = view("flags")!,
      codes = view(column)!,
      docs = view("documents"),
      positions = view("positions"),
      q = quantizerForMaximum(batch.block.scoreMaximum[words.length - 2], 16);
    let excluded = 0;
    for (let row = batch.first; row < batch.end; row++) {
      while (
        batch.excludedRows &&
        excluded < batch.excludedRows.length &&
        batch.excludedRows[excluded] < row
      )
        excluded++;
      if (
        batch.excludedRows?.[excluded] === row ||
        !(flags.getUint16(row * 2, true) & bit)
      )
        continue;
      const sourceRow = batch.sourceRows?.[row] ?? row,
        id = batch.block.first + sourceRow,
        bounds = scoreInterval(codes.getUint16(row * 2, true), q);
      if (!heap.accepts(id, bounds.lower)) {
        tailUpper = Math.max(tailUpper, bounds.upper);
        continue;
      }
      const evicted = heap.threshold?.doc;
      if (evicted !== undefined) {
        tailUpper = Math.max(tailUpper, kept.get(evicted)!.upper);
        kept.delete(evicted);
      }
      heap.add({ doc: id, score: bounds.lower, row: sourceRow });
      kept.set(id, {
        block: batch.block,
        row: sourceRow,
        ...bounds,
        ...(docs && positions
          ? {
              doc: docs.getUint32(row * 4, true),
              position: positions.getUint32(row * 4, true),
            }
          : {}),
      });
    }
  }
  const selected = [...kept.values()],
    blocks = [
      ...new Set(
        selected.filter((e) => e.doc === undefined).map((e) => e.block),
      ),
    ],
    columns = await reader.columns(blocks, ["documents", "positions"]),
    entries = selected.map((e) => {
      if (e.doc !== undefined)
        return {
          doc: e.doc,
          position: e.position!,
          lower: e.lower,
          upper: e.upper,
        };
      const data = columns.get(e.block)!,
        value = (name: "documents" | "positions") => {
          const raw = data[name]!;
          return new DataView(
            raw.buffer,
            raw.byteOffset,
            raw.byteLength,
          ).getUint32(e.row * 4, true);
        };
      return {
        doc: value("documents"),
        position: value("positions"),
        lower: e.lower,
        upper: e.upper,
      };
    });
  return { words: Array.from(words), entries, tailUpper };
}
