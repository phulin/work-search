import type { Branch, Ref } from "./format.js";

/** Estimates choose work; only outward score bounds may reject documents. */
export function outward(score: number, terms: number) {
  return score * (1 + Number.EPSILON * (64 + terms * 4));
}
export function essentialTerms(
  blocks: Branch[][],
  bounds: number[],
  scoring: number[],
  required: number[],
  size: number,
  threshold: number | undefined,
  exactTotal: boolean,
): number[] | undefined {
  if (exactTotal || blocks.length < 2) return;
  const counts = blocks.map((bs) =>
      bs.reduce(
        (n, b) => n + b.count * Math.min(1, size / (b.last - b.first + 1)),
        0,
      ),
    ),
    anchor = [...required].sort((a, b) => counts[a] - counts[b])[0];
  // A mandatory word is a complete candidate generator, independently of rank.
  if (anchor !== undefined && counts[anchor] <= size / 4) return [anchor];
  if (threshold === undefined || threshold <= 0) return;
  let remaining = 0;
  const optional = new Set<number>();
  for (const j of [...scoring].sort((a, b) => bounds[a] - bounds[b])) {
    const next = remaining + bounds[j];
    // Strict inequality: a document outside the essential union cannot tie.
    if (outward(next, scoring.length) >= threshold) break;
    remaining = next;
    optional.add(j);
  }
  const essential = scoring.filter((j) => !optional.has(j));
  if (essential.length && essential.length < blocks.length) return essential;
}

export function cellBounds(
  blocks: Branch[][],
  first: number,
  size: number,
  field: "all" | "body" | "title",
  boost: number,
) {
  return blocks.map((bs) => {
    const result = new Float64Array(Math.ceil(size / 128));
    for (let cell = 0; cell < result.length; cell++) {
      const lo = first + cell * 128,
        hi = Math.min(first + size, lo + 128);
      let b = 0,
        t = 0;
      for (const block of bs)
        if (block.last >= lo && block.first < hi) {
          b = Math.max(b, block.b);
          t = Math.max(t, block.t);
        }
      result[cell] =
        (field !== "title" ? b : 0) + (field !== "body" ? boost * t : 0);
    }
    return result;
  });
}

/** A network-wave decision, independent of matching/pruning proofs. Use the
 * same estimate for lookahead prefetch and the actual window's first read. */
export function deferScoreFetch(
  blocks: Branch[][],
  essential: number[] | undefined,
  size: number,
  resident: (ref: Ref) => boolean,
) {
  if (!essential) return false;
  const optional = blocks.flatMap((bs, j) =>
      essential.includes(j) ? [] : bs.map((b) => b.score),
    ),
    expectedCandidates = Math.min(
      size,
      essential.reduce(
        (n, j) =>
          n +
          blocks[j].reduce(
            (s, b) => s + b.count * Math.min(1, size / (b.last - b.first + 1)),
            0,
          ),
        0,
      ),
    ),
    expectedSaved =
      optional.reduce((n, r) => n + r[2], 0) *
      Math.exp((-128 * expectedCandidates) / size);
  // For resident pages the extra logical phase adds no network dependency.
  // Otherwise require enough expected avoided transfer/decode work to repay it.
  return optional.every(resident) || expectedSaved >= 65536;
}
