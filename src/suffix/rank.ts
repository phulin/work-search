import { Heap, type Hit } from "../columnar/top-k.js";
import {
  canonicalBit,
  quantizerForMaximum,
  type SuffixColumn,
} from "./format.js";
import type { SuffixReader } from "./reader.js";
export interface SuffixRankOptions {
  bits: 8 | 16;
  field?: "all" | "body" | "title";
  limit: number;
  after?: { doc: number; score: number };
  rangeMax?: boolean;
}
/** Quantization never chooses the final order. Conservative score thresholds
 * come only from verified phrase matches; finalists are always rescored. */
export async function rankSuffix(
  reader: SuffixReader,
  phrase: Uint32Array,
  options: SuffixRankOptions,
  rescore: (documents: Uint32Array) => Promise<Float64Array>,
) {
  if (phrase.length < 2 || phrase.length > 5 || options.limit < 1)
    throw Error("Suffix score prefixes cover lengths 2–5");
  const interval = await reader.interval(phrase),
    heap = new Heap(options.limit),
    proven = new Heap(options.limit),
    field = options.field ?? "all",
    bit = canonicalBit(phrase.length, field),
    scoreColumn = `score${options.bits}-${phrase.length}` as SuffixColumn,
    pending = new Map<
      number,
      { doc: number; first: number; titleOnly: boolean; upper: number }
    >();
  const competitive = (upper: number, doc: number) =>
    heap.accepts(doc, upper) && proven.accepts(doc, upper);
  const flush = async () => {
    const candidates = [...pending.values()]
      .filter((c) => competitive(c.upper, c.doc))
      .sort((a, b) => a.doc - b.doc);
    pending.clear();
    if (!candidates.length) return;
    reader.stats.rescoreCandidates += candidates.length;
    const scores = await rescore(Uint32Array.from(candidates, (c) => c.doc));
    if (scores.length !== candidates.length)
      throw Error("Incomplete suffix score completion");
    for (let i = 0; i < scores.length; i++) {
      const c = candidates[i],
        score = scores[i];
      if (!Number.isFinite(score) || score < 0 || score > c.upper)
        throw Error("Suffix quantization bound violated");
      if (
        options.after &&
        (score > options.after.score ||
          (score === options.after.score && c.doc <= options.after.doc))
      )
        continue;
      heap.add({
        doc: c.doc,
        score,
        row: c.doc % 4096,
        first: c.first,
        titleOnly: c.titleOnly,
      });
    }
  };
  if (options.rangeMax)
    interval.blocks.sort((a, b) => {
      const maxima = (v: typeof a) => v.scoreMaximum[phrase.length - 2];
      return maxima(b) - maxima(a) || a.minDocument - b.minDocument;
    });
  const admit = (block: (typeof interval.blocks)[number]) => {
    const maximum = block.scoreMaximum[phrase.length - 2],
      error = 128 * Number.EPSILON * Math.max(1, maximum);
    return competitive(maximum + error, block.minDocument);
  };
  for await (const batch of reader.scan(
    interval,
    ["documents", "positions", "flags", scoreColumn],
    options.rangeMax ? admit : undefined,
  )) {
    const view = (name: SuffixColumn) => {
        const b = batch.columns[name]!;
        return new DataView(b.buffer, b.byteOffset, b.byteLength);
      },
      docs = view("documents"),
      positions = view("positions"),
      flags = view("flags"),
      scores = view(scoreColumn),
      q = quantizerForMaximum(
        batch.block.scoreMaximum[phrase.length - 2],
        options.bits,
      ),
      error = 128 * Number.EPSILON * Math.max(1, q.maximum);
    for (let row = batch.first; row < batch.end; row++) {
      if (!(flags.getUint16(row * 2, true) & bit)) continue;
      const doc = docs.getUint32(row * 4, true),
        position = positions.getUint32(row * 4, true),
        titleOnly = position >= 2 ** 31;
      if ((field === "body" && titleOnly) || (field === "title" && !titleOnly))
        continue;
      const code =
          options.bits === 16
            ? scores.getUint16(row * 2, true)
            : scores.getUint8(row),
        lower = Math.max(0, code * q.step - error),
        upper = Math.min(q.maximum, (code + 1) * q.step) + error;
      if (field === "all" && options.after && lower > options.after.score)
        continue;
      // Canonical rows prove membership. K conservative lower scores can prune
      // upper bounds before score completion. With a cursor, uncertain rows on
      // its wrong side must not establish a competitive threshold.
      const fieldLower = field === "all" ? lower : 0;
      if (
        (!options.after ||
          upper < options.after.score ||
          (upper === options.after.score && doc > options.after.doc)) &&
        proven.accepts(doc, fieldLower)
      )
        proven.add({ doc, score: fieldLower, row: doc % 4096 });
      if (!competitive(upper, doc)) continue;
      // For body/title, the all-field score remains a conservative upper bound.
      pending.set(doc, {
        doc,
        first: position % 2 ** 31,
        titleOnly,
        upper,
      });
      if (pending.size >= 1024) await flush();
    }
    // Range-max execution needs a verified threshold before the next batch.
    if (options.rangeMax) await flush();
  }
  await flush();
  return heap.values.sort(
    (a, b) => b.score - a.score || a.doc - b.doc,
  ) as Hit[];
}
