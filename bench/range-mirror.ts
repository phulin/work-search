export async function assembleRange(
  offset: number,
  length: number,
  intervals: { offset: number; length: number }[],
  read: (r: { offset: number; length: number }) => Promise<Uint8Array>,
) {
  const pieces: Uint8Array[] = [];
  let cursor = offset;
  while (cursor < offset + length) {
    const candidate = intervals
      .filter((r) => r.offset <= cursor && r.offset + r.length > cursor)
      .sort((a, b) => b.offset + b.length - (a.offset + a.length))[0];
    if (!candidate) return null;
    try {
      const bytes = await read(candidate);
      if (bytes.length !== candidate.length)
        throw Error("Truncated mirror interval");
      const end = Math.min(
        offset + length,
        candidate.offset + candidate.length,
      );
      pieces.push(
        bytes.subarray(cursor - candidate.offset, end - candidate.offset),
      );
      cursor = end;
    } catch {
      const i = intervals.indexOf(candidate);
      if (i >= 0) intervals.splice(i, 1);
    }
  }
  return Buffer.concat(pieces);
}
