// Minimize bytes + request-overhead-equivalent bytes under a range-count cap.
// Each partition boundary saves a gap and adds one request; largest profitable
// gaps therefore give the exact optimum for ordered nonoverlapping ranges.
export function rangeGroups(
  indices: number[],
  extent: (i: number) => { start: number; end: number },
  overhead = 65536,
  maxRanges = 4,
): number[][] {
  if (!indices.length) return [];
  const gaps = indices
    .slice(1)
    .map((index, i) => ({
      at: i + 1,
      saved: extent(index).start - extent(indices[i]).end,
    }));
  const cuts = new Set(
    gaps
      .filter((g) => g.saved > overhead)
      .sort((a, b) => b.saved - a.saved || a.at - b.at)
      .slice(0, maxRanges - 1)
      .map((g) => g.at),
  );
  const groups: number[][] = [];
  let group: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    if (cuts.has(i)) {
      groups.push(group);
      group = [];
    }
    group.push(indices[i]);
  }
  groups.push(group);
  return groups;
}
