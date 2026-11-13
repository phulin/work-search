import { outward } from "./maxscore.js";
import type { ScoreBatch } from "./score-batch.js";
import type { Hit } from "./top-k.js";

/** Synchronous numeric kernels keep transient scores out of the async executor's
 * captured state. The heap is unchanged until positional verification later in
 * the band, so a single threshold snapshot is sufficient for both scans. */
export function selectCandidates(
  first: number,
  size: number,
  cells: Uint8Array,
  mask: Uint8Array | undefined,
  predicate: (d: number) => number,
  batches: ScoreBatch[],
  scoring: number[],
  essential: number[] | undefined,
  loaded: Uint8Array,
  bounds: Float64Array[],
  body: boolean,
  title: number,
  threshold: Hit | undefined,
  candidates: Uint32Array,
) {
  let count = 0,
    rejected = 0;
  for (let d = 0; d < size; d++) {
    if (!cells[d >>> 7] || (mask && !mask[d])) continue;
    if (essential) {
      let present = false;
      for (let i = 0; i < essential.length; i++)
        if (batches[essential[i]].handle[d]) {
          present = true;
          break;
        }
      // essentialTerms proves completeness: a mandatory anchor, or the union
      // remaining after optional maxima fall strictly below verified top-K.
      // Presence in another field may admit extra candidates, never omit one.
      if (!present) {
        rejected++;
        continue;
      }
    }
    if (predicate(d) === 0) continue;
    if (threshold) {
      let bound = 0;
      for (let i = 0; i < scoring.length; i++) {
        const j = scoring[i],
          batch = batches[j];
        bound += loaded[j]
          ? (body ? batch.b[d] : 0) + title * batch.t[d]
          : bounds[j][d >>> 7];
      }
      const rounded = outward(bound, scoring.length);
      if (
        rounded < threshold.score ||
        (rounded === threshold.score && first + d > threshold.doc)
      ) {
        rejected++;
        continue;
      }
    }
    candidates[count++] = first + d;
  }
  return { count, rejected };
}

export function scoreCandidates(
  first: number,
  count: number,
  predicate: (d: number) => number,
  batches: ScoreBatch[],
  scoring: number[],
  body: boolean,
  title: number,
  after: { score: number; doc: number } | undefined,
  threshold: Hit | undefined,
  candidates: Uint32Array,
  values: Float64Array,
) {
  let kept = 0,
    visited = 0;
  for (let i = 0; i < count; i++) {
    const doc = candidates[i],
      d = doc - first;
    if (predicate(d) === 0) continue;
    visited++;
    let score = 0;
    // Original term order and float64 arithmetic, including field boosts.
    for (let k = 0; k < scoring.length; k++) {
      const batch = batches[scoring[k]];
      score += (body ? batch.b[d] : 0) + title * batch.t[d];
    }
    if (
      after &&
      (score > after.score || (score === after.score && doc <= after.doc))
    )
      continue;
    if (
      threshold &&
      !(
        score > threshold.score ||
        (score === threshold.score && doc < threshold.doc)
      )
    )
      continue;
    candidates[kept] = doc;
    values[kept++] = score;
  }
  return { count: kept, visited };
}

/** Reuse the same conservative cell maxima for initial and partial pruning. */
export function pruneCells(
  cells: Uint8Array,
  bounds: Float64Array[],
  scoring: number[],
  first: number,
  threshold: Hit,
) {
  for (let cell = 0; cell < cells.length; cell++) {
    let bound = 0;
    for (let i = 0; i < scoring.length; i++) bound += bounds[scoring[i]][cell];
    bound *= 1 + Number.EPSILON * 32;
    if (
      bound < threshold.score ||
      (bound === threshold.score && first + cell * 128 > threshold.doc)
    )
      cells[cell] = 0;
  }
}
