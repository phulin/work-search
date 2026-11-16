import type { Node } from "../query/parser.js";
import { lower } from "../columnar/format.js";
import { Heap } from "../columnar/top-k.js";
import {
  canonicalBit,
  quantizerForMaximum,
  type SuffixColumn,
} from "./format.js";
import type { SuffixReader } from "./reader.js";
import type { SuffixRankOptions } from "./rank.js";

/** Every positive word must belong to exactly one mandatory phrase. Repeated
 * words within a phrase are already counted once in its stored score. */
export function scoredConjunction(ast: Node): string[][] | undefined {
  const phrases: string[][] = [],
    seen = new Set<string>();
  const visit = (n: Node): boolean => {
    if (n.kind === "and") return visit(n.left) && visit(n.right);
    if (n.kind !== "phrase" || n.terms.length < 2 || n.terms.length > 5)
      return false;
    const words = new Set(n.terms);
    for (const word of words) if (seen.has(word)) return false;
    for (const word of words) seen.add(word);
    phrases.push(n.terms);
    return true;
  };
  return visit(ast) && phrases.length > 1 ? phrases : undefined;
}

/** Small complete intervals can provide Boolean matching and additive score
 * bounds together. Larger intersections retain the normal bounded executor. */
export async function rankSuffixConjunction(
  reader: SuffixReader,
  phrases: Uint32Array[],
  options: SuffixRankOptions,
  rescore: (documents: Uint32Array) => Promise<Float64Array>,
  budget = 4 * 1048576,
) {
  if (phrases.reduce((n, p) => n + reader.minimumRows(p) * 48, 0) > budget)
    return;
  const bounds = await Promise.all(phrases.map((p) => reader.shortInterval(p)));
  // Sorting and intersections need temporary arrays too, not just retained
  // scores. Bound their sum before opening payload columns.
  if (bounds.reduce((n, r) => n + (r.end - r.first) * 48, 0) > budget) return;
  const intervals = await Promise.all(bounds.map((b) => reader.expand(b)));
  const field = options.field ?? "all",
    rows = await Promise.all(
      intervals.map(async (interval, i) => {
        const length = phrases[i].length,
          capacity = interval.end - interval.first,
          docs = new Uint32Array(capacity),
          lowerScores = new Float64Array(capacity),
          upperScores = new Float64Array(capacity),
          bit = canonicalBit(length, field),
          column = `score${options.bits}-${length}` as SuffixColumn;
        let count = 0;
        for await (const batch of reader.scan(interval, [
          "documents",
          "flags",
          column,
        ])) {
          const view = (name: SuffixColumn) => {
              const b = batch.columns[name]!;
              return new DataView(b.buffer, b.byteOffset, b.byteLength);
            },
            d = view("documents"),
            f = view("flags"),
            s = view(column),
            q = quantizerForMaximum(
              batch.block.scoreMaximum[length - 2],
              options.bits,
            ),
            error = 128 * Number.EPSILON * Math.max(1, q.maximum);
          for (let j = batch.first; j < batch.end; j++) {
            if (!(f.getUint16(j * 2, true) & bit)) continue;
            const code =
              options.bits === 16 ? s.getUint16(j * 2, true) : s.getUint8(j);
            docs[count] = d.getUint32(j * 4, true);
            lowerScores[count] =
              field === "all" ? Math.max(0, code * q.step - error) : 0;
            upperScores[count++] =
              Math.min(q.maximum, (code + 1) * q.step) + error;
          }
        }
        const order = Uint32Array.from({ length: count }, (_, j) => j);
        order.sort((a, b) => docs[a] - docs[b]);
        return {
          docs: Uint32Array.from(order, (j) => docs[j]),
          lo: Float64Array.from(order, (j) => lowerScores[j]),
          hi: Float64Array.from(order, (j) => upperScores[j]),
        };
      }),
    );
  rows.sort((a, b) => a.docs.length - b.docs.length);
  const candidates = new Uint32Array(rows[0].docs.length),
    upper = new Float64Array(candidates.length),
    proven = new Heap(options.limit);
  let count = 0;
  for (let i = 0; i < rows[0].docs.length; i++) {
    const doc = rows[0].docs[i];
    let lo = rows[0].lo[i],
      hi = rows[0].hi[i],
      match = true;
    for (let j = 1; j < rows.length; j++) {
      const r = rows[j],
        at = lower(r.docs, doc);
      if (r.docs[at] !== doc) {
        match = false;
        break;
      }
      lo += r.lo[at];
      hi += r.hi[at];
    }
    if (!match) continue;
    // Allow the original scorer to add distinct words in a different order.
    const error = 128 * Number.EPSILON * Math.max(1, hi) * phrases.length;
    if (options.after && lo - error > options.after.score) continue;
    if (
      (!options.after ||
        hi + error < options.after.score ||
        (hi + error === options.after.score && doc > options.after.doc)) &&
      proven.accepts(doc, Math.max(0, lo - error))
    )
      proven.add({ doc, score: Math.max(0, lo - error), row: doc % 4096 });
    candidates[count] = doc;
    upper[count++] = hi + error;
  }
  const order = Uint32Array.from({ length: count }, (_, i) => i),
    heap = new Heap(options.limit);
  if (options.rangeMax)
    order.sort((a, b) => upper[b] - upper[a] || candidates[a] - candidates[b]);
  for (let start = 0; start < count; start += 1024) {
    const selected: number[] = [];
    for (let i = start; i < Math.min(count, start + 1024); i++) {
      const at = order[i];
      if (
        heap.accepts(candidates[at], upper[at]) &&
        proven.accepts(candidates[at], upper[at])
      )
        selected.push(at);
    }
    if (!selected.length) continue;
    reader.stats.rescoreCandidates += selected.length;
    const scores = await rescore(
      Uint32Array.from(selected, (i) => candidates[i]),
    );
    if (scores.length !== selected.length)
      throw Error("Incomplete Boolean suffix score completion");
    for (let j = 0; j < selected.length; j++) {
      const at = selected[j],
        doc = candidates[at],
        score = scores[j];
      if (!Number.isFinite(score) || score < 0 || score > upper[at])
        throw Error("Boolean suffix quantization bound violated");
      if (
        options.after &&
        (score > options.after.score ||
          (score === options.after.score && doc <= options.after.doc))
      )
        continue;
      heap.add({ doc, score, row: doc % 4096 });
    }
  }
  return heap.values.sort((a, b) => b.score - a.score || a.doc - b.doc);
}
