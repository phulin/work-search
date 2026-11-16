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
  if (phrases.some((p) => p.some((word) => !word))) return [];
  if (phrases.reduce((n, p) => n + reader.minimumRows(p) * 48, 0) > budget)
    return;
  const bounds = await Promise.all(
    phrases.map((p) =>
      reader.numericInterval(
        p,
        options.field && options.field !== "all"
          ? ["documents", "positions"]
          : ["documents"],
      ),
    ),
  );
  if (bounds.some((b) => b.first === b.end)) return [];
  // Sorting and intersections need temporary arrays too, not just retained
  // scores. Bound their sum before opening payload columns.
  if (bounds.reduce((n, r) => n + (r.end - r.first) * 48, 0) > budget) return;
  const field = options.field ?? "all";
  // Read matching document IDs alongside block metadata. Exact phrase intervals
  // establish membership without opening flags or score columns.
  const [intervals, memberships] = await Promise.all([
    Promise.all(
      bounds.map((b, i) =>
        reader.expand(b, [
          "documents",
          "flags",
          `score${options.bits}-${phrases[i].length}`,
        ]),
      ),
    ),
    Promise.all(
      bounds.map(async (bound) => {
        const names: SuffixColumn[] =
            field === "all" ? ["documents"] : ["documents", "positions"],
          interval = await reader.expand(bound, names),
          docs = new Uint32Array(bound.end - bound.first);
        let count = 0;
        for await (const batch of reader.scan(interval, names)) {
          const raw = batch.columns.documents!,
            d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
            positions = batch.columns.positions,
            p =
              positions &&
              new DataView(
                positions.buffer,
                positions.byteOffset,
                positions.byteLength,
              );
          for (let j = batch.first; j < batch.end; j++) {
            const title = p ? p.getUint32(j * 4, true) >= 2 ** 31 : false;
            if ((field === "body" && title) || (field === "title" && !title))
              continue;
            docs[count++] = d.getUint32(j * 4, true);
          }
        }
        reader.stats.membershipRows += count;
        const sorted = docs.subarray(0, count).sort();
        let unique = 0;
        for (let j = 0; j < sorted.length; j++)
          if (!j || sorted[j] !== sorted[j - 1]) sorted[unique++] = sorted[j];
        return sorted.subarray(0, unique);
      }),
    ),
  ]);
  memberships.sort((a, b) => a.length - b.length);
  const matching = new Uint32Array(memberships[0].length);
  let matchCount = 0;
  for (const doc of memberships[0]) {
    let present = true;
    for (let i = 1; i < memberships.length; i++)
      if (memberships[i][lower(memberships[i], doc)] !== doc) {
        present = false;
        break;
      }
    if (present) matching[matchCount++] = doc;
  }
  const matches = matching.subarray(0, matchCount);
  reader.stats.intersectionCandidates += matchCount;
  if (matchCount <= options.limit) {
    if (!matchCount) return [];
    reader.stats.rescoreCandidates += matchCount;
    const scores = await rescore(matches),
      heap = new Heap(options.limit);
    if (scores.length !== matchCount)
      throw Error("Incomplete Boolean suffix score completion");
    for (let i = 0; i < matchCount; i++) {
      const doc = matches[i],
        score = scores[i];
      if (!Number.isFinite(score) || score < 0)
        throw Error("Invalid Boolean suffix score");
      if (
        options.after &&
        (score > options.after.score ||
          (score === options.after.score && doc <= options.after.doc))
      )
        continue;
      heap.add({ doc, score, row: doc % 4096 });
    }
    return heap.values.sort((a, b) => b.score - a.score || a.doc - b.doc);
  }
  const candidateSet = new Set(matches);
  const rows = await Promise.all(
    intervals.map(async (interval, i) => {
      const length = phrases[i].length,
        capacity = matchCount,
        docs = new Uint32Array(capacity),
        lowerScores = new Float64Array(capacity),
        upperScores = new Float64Array(capacity),
        bit = canonicalBit(length, field),
        column = `score${options.bits}-${length}` as SuffixColumn;
      let count = 0;
      const useful = await Promise.all(
        interval.blocks.map(async (block) => {
          const raw = await reader.column(block, "documents"),
            view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          for (
            let j = Math.max(0, interval.first - block.first);
            j < Math.min(block.count, interval.end - block.first);
            j++
          )
            if (candidateSet.has(view.getUint32(j * 4, true))) return block;
        }),
      );
      const selected = {
        ...interval,
        blocks: useful.filter((b): b is NonNullable<typeof b> => !!b),
      };
      for await (const batch of reader.scan(selected, [
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
          const doc = d.getUint32(j * 4, true);
          if (!candidateSet.has(doc)) continue;
          docs[count] = doc;
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
