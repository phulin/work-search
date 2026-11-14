import type { Root } from "./format.js";

export interface ScoreParameters {
  idf: number;
  avgBody: number;
  avgTitle: number;
}
/** One logarithm per query term, shared by all of its decoding batches. */
export function scoreParameters(
  df: number,
  root: Pick<Root, "count" | "avgBody" | "avgTitle">,
): ScoreParameters {
  return {
    idf: Math.log(1 + (root.count - df + 0.5) / (df + 0.5)),
    avgBody: root.avgBody || 1,
    avgTitle: root.avgTitle || 1,
  };
}
export function contribution(
  tf: number,
  length: number,
  average: number,
  idf: number,
) {
  return tf
    ? (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * length) / average))
    : 0;
}
