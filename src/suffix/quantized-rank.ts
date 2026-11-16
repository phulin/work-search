import { Heap, type Hit } from "../columnar/top-k.js";
import {
  canonicalBit,
  quantizerForMaximum,
  type SuffixBlock,
  type SuffixColumn,
} from "./format.js";
import type { SuffixReader } from "./reader.js";
import type { SuffixRankOptions } from "./rank.js";

/** Canonical rows prove a phrase match. Their conservative lower scores can
 * establish a threshold before document IDs or positions have been fetched.
 * Document/tie order is resolved only after retrieving the uncertain finalists. */
export async function rankQuantizedRows(
  reader: SuffixReader,
  phrase: Uint32Array,
  options: SuffixRankOptions,
  rescore: (documents: Uint32Array) => Promise<Float64Array>,
) {
  const bundled = options.rangeMax
    ? await reader.phraseRanking(phrase, options.limit, options.after)
    : undefined;
  if (bundled) {
    reader.stats.rescoreCandidates += bundled.length;
    const scores = await rescore(Uint32Array.from(bundled, (e) => e.doc));
    if (scores.length !== bundled.length)
      throw Error("Incomplete suffix score completion");
    return bundled
      .map((e, i) => {
        const score = scores[i];
        if (!Number.isFinite(score) || score < e.lower || score > e.upper)
          throw Error("Suffix quantization bound violated");
        return {
          doc: e.doc,
          score,
          row: e.doc % 4096,
          first: e.position % 2 ** 31,
          titleOnly: e.position >= 2 ** 31,
        };
      })
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .slice(0, options.limit);
  }
  const heap = new Heap(options.limit),
    proven = new Heap(options.limit),
    refined = new Heap(options.limit),
    bit = canonicalBit(phrase.length, "all"),
    column = `score${options.bits}-${phrase.length}` as SuffixColumn,
    pending = new Map<
      number,
      {
        block: SuffixBlock;
        row: number;
        upper: number;
        refined?: boolean;
        doc?: number;
        position?: number;
      }
    >();
  const threshold = () =>
      Math.max(
        heap.threshold?.score ?? 0,
        proven.threshold?.score ?? 0,
        refined.threshold?.score ?? 0,
      ),
    competitive = (upper: number) => upper >= threshold();
  async function flush() {
    // An 8-bit interval can leave thousands of indistinguishable rows. Refine
    // those numeric bounds from the existing 16-bit column before paying for
    // document reads; this never replaces exact final scoring.
    if (options.bits === 8 && pending.size > Math.max(64, 2 * options.limit)) {
      const blocks = [
          ...new Set(
            [...pending.values()]
              .filter((p) => !p.refined && competitive(p.upper))
              .map((p) => p.block),
          ),
        ],
        name = `score16-${phrase.length}` as SuffixColumn,
        columns = await reader.columns(blocks, [name]);
      if (blocks.length) reader.stats.precisionRefinements++;
      for (const [id, p] of pending) {
        if (p.refined || !competitive(p.upper)) continue;
        const raw = columns.get(p.block)![name],
          q = quantizerForMaximum(p.block.scoreMaximum[phrase.length - 2], 16),
          error = 128 * Number.EPSILON * Math.max(1, q.maximum),
          code = new DataView(
            raw.buffer,
            raw.byteOffset,
            raw.byteLength,
          ).getUint16(p.row * 2, true),
          lower = Math.max(0, code * q.step - error);
        p.upper = Math.min(
          p.upper,
          Math.min(q.maximum, (code + 1) * q.step) + error,
        );
        p.refined = true;
        reader.stats.refinedRows++;
        if (!options.after || p.upper < options.after.score)
          refined.add({ doc: id, score: lower, row: p.row });
      }
    }
    const selected = [...pending.values()].filter((p) => competitive(p.upper));
    pending.clear();
    if (!selected.length) return;
    const blocks = [
        ...new Set(
          selected.filter((p) => p.doc === undefined).map((p) => p.block),
        ),
      ],
      columns = await reader.columns(blocks, ["documents", "positions"]),
      candidates = selected
        .map((p) => {
          if (p.doc !== undefined)
            return { doc: p.doc, position: p.position!, upper: p.upper };
          const { documents: d, positions: pos } = columns.get(p.block)!,
            doc = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(
              p.row * 4,
              true,
            ),
            position = new DataView(
              pos.buffer,
              pos.byteOffset,
              pos.byteLength,
            ).getUint32(p.row * 4, true);
          return { doc, position, upper: p.upper };
        })
        .filter((c) => heap.accepts(c.doc, c.upper))
        .sort((a, b) => a.doc - b.doc);
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
        first: c.position % 2 ** 31,
        titleOnly: c.position >= 2 ** 31,
      });
    }
  }
  const admit = (max: number) => {
    return competitive(max + 128 * Number.EPSILON * Math.max(1, max));
  };
  const scan = options.rangeMax
    ? reader.rankedScan(phrase, ["flags", column], admit)
    : reader.scan(await reader.interval(phrase), ["flags", column]);
  for await (const batch of scan) {
    const bits = batch.scoreBits ?? options.bits,
      name = `score${bits}-${phrase.length}` as SuffixColumn;
    const flags = batch.columns.flags!,
      codes = batch.columns[name]!,
      fv = new DataView(flags.buffer, flags.byteOffset, flags.byteLength),
      cv = new DataView(codes.buffer, codes.byteOffset, codes.byteLength),
      q = quantizerForMaximum(
        batch.block.scoreMaximum[phrase.length - 2],
        bits,
      ),
      error = 128 * Number.EPSILON * Math.max(1, q.maximum);
    let excluded = 0;
    const knownDocs = batch.sourceRows ? batch.columns.documents! : undefined,
      knownPositions = batch.sourceRows ? batch.columns.positions! : undefined,
      dv = knownDocs
        ? new DataView(
            knownDocs.buffer,
            knownDocs.byteOffset,
            knownDocs.byteLength,
          )
        : undefined,
      pv = knownPositions
        ? new DataView(
            knownPositions.buffer,
            knownPositions.byteOffset,
            knownPositions.byteLength,
          )
        : undefined;
    for (let row = batch.first; row < batch.end; row++) {
      while (
        batch.excludedRows &&
        excluded < batch.excludedRows.length &&
        batch.excludedRows[excluded] < row
      )
        excluded++;
      if (batch.excludedRows?.[excluded] === row) continue;
      if (!(fv.getUint16(row * 2, true) & bit)) continue;
      const code = bits === 16 ? cv.getUint16(row * 2, true) : cv.getUint8(row),
        lower = Math.max(0, code * q.step - error),
        upper = Math.min(q.maximum, (code + 1) * q.step) + error;
      if (options.after && lower > options.after.score) continue;
      const sourceRow = batch.sourceRows?.[row] ?? row,
        identity = batch.block.first + sourceRow;
      // With no document ID yet, equality at the cursor cannot prove eligibility.
      // Using only strict score comparisons also preserves all possible ties.
      if (!options.after || upper < options.after.score)
        proven.add({ doc: identity, score: lower, row });
      if (!competitive(upper)) continue;
      pending.set(identity, {
        block: batch.block,
        row: sourceRow,
        upper,
        ...(batch.sourceRows
          ? {
              doc: dv!.getUint32(row * 4, true),
              position: pv!.getUint32(row * 4, true),
              refined: true,
            }
          : {}),
      });
      if (pending.size >= 1024) {
        for (const [id, c] of pending)
          if (!competitive(c.upper)) pending.delete(id);
        if (pending.size >= 1024) await flush();
      }
    }
  }
  await flush();
  return heap.values.sort(
    (a, b) => b.score - a.score || a.doc - b.doc,
  ) as Hit[];
}
