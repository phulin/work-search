import { Heap, type Hit } from "../columnar/top-k.js";
import { canonicalBit, type SuffixColumn } from "./format.js";
import type { SuffixReader } from "./reader.js";
export interface SuffixRankOptions {
  bits: 8 | 16;
  field?: "all" | "body" | "title";
  limit: number;
  after?: { doc: number; score: number };
  rangeMax?: boolean;
}
/** Quantization never chooses the final order. A threshold is raised only by
 * exact rescoring of documents whose phrase membership is already established. */
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
    field = options.field ?? "all",
    bit = canonicalBit(phrase.length, field),
    scoreColumn = `score${options.bits}-${phrase.length}` as SuffixColumn,
    pending = new Map<
      number,
      { doc: number; first: number; titleOnly: boolean; upper: number }
    >();
  const competitive = (upper: number, doc: number) =>
    !heap.threshold ||
    upper > heap.threshold.score ||
    (upper === heap.threshold.score && doc < heap.threshold.doc);
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
      const maxima = (v: typeof a) =>
        options.bits === 16
          ? v.maxima16[phrase.length - 2]
          : v.maxima8[phrase.length - 2];
      return maxima(b) - maxima(a) || a.minDocument - b.minDocument;
    });
  const admit = (block: (typeof interval.blocks)[number]) => {
    const maximum = (options.bits === 16 ? block.maxima16 : block.maxima8)[
      phrase.length - 2
    ];
    return competitive(
      reader.bounds(maximum, options.bits).upper,
      block.minDocument,
    );
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
      scores = view(scoreColumn);
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
        bounds = reader.bounds(code, options.bits);
      if (
        field === "all" &&
        options.after &&
        bounds.lower > options.after.score
      )
        continue;
      if (!competitive(bounds.upper, doc)) continue;
      // For body/title, the all-field score remains a conservative upper bound.
      pending.set(doc, {
        doc,
        first: position % 2 ** 31,
        titleOnly,
        upper: bounds.upper,
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
