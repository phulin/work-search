import {
  indexPairOccurrenceRuns,
  mergePairOccurrenceRuns,
} from "./pair-occurrences.js";
import type { BuildStore } from "./runs.js";
export async function pairRangeJob(
  store: BuildStore,
  path: string,
  input: any,
) {
  if (path === "/pair-restarts")
    return { runs: await indexPairOccurrenceRuns(store, input.runs) };
  if (path !== "/merge-pair-occurrences-range" || !input.range)
    throw Error("Invalid pair range operation");
  return { run: await mergePairOccurrenceRuns(store, input.runs, input.range) };
}
