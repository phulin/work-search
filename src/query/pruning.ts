import type { BinaryIndex, Entry } from "../format/index.js";
import type { DecodedPostings } from "../format/codec.js";
import type { SearchRuntime } from "./runtime.js";
export const SCORE_BLOCK = 1024;
export function scoreBounds(
  index: BinaryIndex,
  e: Entry,
  list: DecodedPostings,
  idf: number,
  runtime?: SearchRuntime,
) {
  const key = JSON.stringify([
    index.generation,
    "score-bounds",
    e.term,
    e.df,
    e.crc,
  ]);
  const full = list.docs.length === e.df;
  const cached = full ? runtime?.get<Float64Array>(key) : undefined;
  if (cached) return { bounds: cached, hit: true };
  const bounds = new Float64Array(Math.ceil(index.count / SCORE_BLOCK) * 2),
    lengths = { body: 0, title: 0 };
  for (let row = 0; row < list.docs.length; row++) {
    const doc = list.docs[row];
    if (doc >= index.count) throw new Error("Posting document out of range");
    index.lengths(doc, lengths);
    const bucket = Math.floor(doc / SCORE_BLOCK) * 2;
    const body = list.body[row],
      title = list.title[row];
    if (body) {
      const score =
        (idf * (body * 2.2)) /
        (body +
          1.2 * (1 - 0.75 + (0.75 * lengths.body) / (index.avgBody || 1)));
      if (score > bounds[bucket]) bounds[bucket] = score;
    }
    if (title) {
      const score =
        (idf * (title * 2.2)) /
        (title +
          1.2 * (1 - 0.75 + (0.75 * lengths.title) / (index.avgTitle || 1)));
      if (score > bounds[bucket + 1]) bounds[bucket + 1] = score;
    }
  }
  if (full) runtime?.set(key, bounds, bounds.byteLength);
  return { bounds, hit: false };
}
