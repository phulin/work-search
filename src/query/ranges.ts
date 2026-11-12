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
  const gaps = indices.slice(1).map((index, i) => ({
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

export interface ReadPlan {
  latencyMs: number;
  bandwidthMiB: number;
  lanes: number;
}
/** Largest gaps minimize transferred bytes for each K; select K by waves + transfer time. */
export function networkGroups(
  indices: number[],
  extent: (i: number) => { start: number; end: number },
  plan: ReadPlan,
  multiplier = 1,
): number[][] {
  if (!indices.length) return [];
  if (
    !Number.isFinite(plan.latencyMs) ||
    plan.latencyMs < 0 ||
    !Number.isFinite(plan.bandwidthMiB) ||
    plan.bandwidthMiB <= 0 ||
    !Number.isInteger(plan.lanes) ||
    plan.lanes < 1 ||
    plan.lanes > 4
  )
    throw Error("Invalid read plan");
  const gaps = indices
    .slice(1)
    .map((i, j) => ({
      at: j + 1,
      saved: extent(i).start - extent(indices[j]).end,
    }))
    .filter((g) => g.saved > 0)
    .sort((a, b) => b.saved - a.saved || a.at - b.at);
  const span =
    extent(indices[indices.length - 1]).end - extent(indices[0]).start;
  let best = Infinity,
    cuts = new Set<number>(),
    saved = 0;
  for (let k = 1; k <= Math.min(4, gaps.length + 1); k++) {
    if (k > 1) saved += gaps[k - 2].saved;
    const cost =
      Math.ceil((k * multiplier) / Math.max(1, plan.lanes)) * plan.latencyMs +
      (span - saved) / ((plan.bandwidthMiB * 1048576) / 1000);
    if (cost < best) {
      best = cost;
      cuts = new Set(gaps.slice(0, k - 1).map((g) => g.at));
    }
  }
  const out: number[][] = [];
  for (let i = 0; i < indices.length; i++) {
    if (!i || cuts.has(i)) out.push([]);
    out[out.length - 1].push(indices[i]);
  }
  return out;
}
