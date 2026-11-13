import type { Run } from "../src/columnar/construction/runs.js";
export interface MergeJob {
  firstRun: number;
  endRun: number;
  group: number;
  lexical?: number;
  range?: { firstWord?: string; endWord?: string };
}
/** Switch from document ranges to a grid of lexical and document ranges before
 * the merge narrows to a few enormous jobs. Every invocation has fan-in <=16. */
export function planMerges(runs: Run[], width: number) {
  if (runs.length < 2 || width < 1 || width > 128)
    throw Error("Invalid merge planning input");
  const lexical = runs.length <= Math.max(16, width),
    jobs: MergeJob[] = [];
  if (!lexical) {
    const groups = Math.min(
      Math.floor(runs.length / 2),
      Math.max(width, Math.ceil(runs.length / 16)),
    );
    for (let group = 0; group < groups; group++)
      jobs.push({
        group,
        firstRun: Math.floor((group * runs.length) / groups),
        endRun: Math.floor(((group + 1) * runs.length) / groups),
      });
    return { lexical, jobs };
  }
  const samples = runs
      .flatMap((r) =>
        r.chunks.flatMap((c) => (c.firstWord ? [c.firstWord] : [])),
      )
      .sort(),
    pieces = Math.min(width, samples.length),
    borders = [
      ...new Set(
        Array.from(
          { length: Math.max(0, pieces - 1) },
          (_, i) => samples[Math.floor((samples.length * (i + 1)) / pieces)],
        ),
      ),
    ],
    groups = Math.ceil(runs.length / 16);
  for (let part = 0; part <= borders.length; part++)
    for (let group = 0; group < groups; group++)
      jobs.push({
        group,
        lexical: part,
        firstRun: Math.floor((group * runs.length) / groups),
        endRun: Math.floor(((group + 1) * runs.length) / groups),
        range: {
          firstWord: part ? borders[part - 1] : undefined,
          endWord: borders[part],
        },
      });
  return { lexical, jobs };
}
