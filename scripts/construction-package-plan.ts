import type { Chunk } from "../src/columnar/construction/runs.js";
/** Reuse any completed range vocabularies and fill every remaining document
 * directly. These are construction jobs, never a filtered candidate set. */
export function packageRanges(
  count: number,
  vocabularies: { segments: { first: number; end: number; ref: Chunk }[] }[],
) {
  if (!Number.isSafeInteger(count) || count < 1)
    throw Error("Invalid package corpus size");
  const ranges: { first: number; end: number; ref?: Chunk }[] = [];
  let next = 0;
  const append = (first: number, end: number, ref?: Chunk) => {
    for (; first < end; first += 1024)
      ranges.push({
        first,
        end: Math.min(first + 1024, end),
        ...(ref ? { ref } : {}),
      });
    next = end;
  };
  for (const segment of vocabularies
    .flatMap((v) => v.segments)
    .sort((a, b) => a.first - b.first)) {
    if (
      !Number.isInteger(segment.first) ||
      !Number.isInteger(segment.end) ||
      segment.first < next ||
      segment.end <= segment.first ||
      segment.end > count
    )
      throw Error("Overlapping or invalid vocabulary coverage");
    if (segment.first > next) append(next, segment.first);
    append(segment.first, segment.end, segment.ref);
  }
  append(next, count);
  return ranges;
}
