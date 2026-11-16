export interface ReadRange {
  key: string;
  offset: number;
  length: number;
}
/** Union only overlapping/adjacent coverage. Holes must remain unavailable. */
export function unionReadRanges(input: Iterable<ReadRange>) {
  const ranges = [...input].sort(
      (a, b) => a.key.localeCompare(b.key) || a.offset - b.offset,
    ),
    out: ReadRange[] = [];
  for (const range of ranges) {
    if (
      !range.key ||
      !Number.isSafeInteger(range.offset) ||
      range.offset < 0 ||
      !Number.isSafeInteger(range.length) ||
      range.length < 1 ||
      !Number.isSafeInteger(range.offset + range.length)
    )
      throw Error("Invalid read range");
    const previous = out.at(-1);
    if (
      previous?.key === range.key &&
      range.offset <= previous.offset + previous.length
    )
      previous.length = Math.max(
        previous.length,
        range.offset + range.length - previous.offset,
      );
    else out.push({ ...range });
  }
  return out;
}
