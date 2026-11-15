import { candidateLayout } from "./candidate-layout.js";
import type { ContinuationContext } from "./search.js";
import { PACKAGE_CONCURRENCY } from "./package-batches.js";
import { PAGE } from "./format.js";
import { SCORE_LOOKAHEAD_WINDOWS } from "./score-lookahead.js";
const BAND = 16384,
  WAVE = 8;
/** Price actual sorted candidates before package I/O. Cost estimates select an
 * exact continuation; they are never matching or ranking bounds. */
export async function priceDocuments(
  context: ContinuationContext,
  candidates: Iterable<number>,
  covered?: (words: string[]) => boolean,
) {
  const { plan, packages, root, terms, reader, ast, options } = context;
  if (!packages) return { ...plan, kind: "blocks" as const };
  const length =
      packages.byteLength ?? (() => Math.ceil(packages.averageBytes)),
    selected: number[] = [];
  // Loose page-envelope ceiling: two potentially straddling score/position
  // blocks per 128 postings, plus the complete position payloads. A losing
  // prefix avoids enumerating enormous sets or opening their detailed plans.
  // The later comparison uses actual candidate-overlapping physical pages.
  const wholeWork =
    [...terms.values()].reduce(
      (n, t) =>
        n +
        4 * Math.ceil(t.df / 128) +
        (t.positional[2] +
          (t.positionalParts ?? []).reduce((n, r) => n + r[2], 0)) /
          PAGE,
      0,
    ) +
    Math.ceil(root.count / BAND) * WAVE;
  let bytes = 0;
  for (const doc of candidates) {
    selected.push(doc);
    bytes += length(doc);
    if (
      bytes / PAGE + Math.ceil(selected.length / PACKAGE_CONCURRENCY) * WAVE >=
      wholeWork
    )
      return { ...plan, kind: "blocks" as const };
  }
  const ids = Uint32Array.from(selected),
    waves = Math.ceil(ids.length / PACKAGE_CONCURRENCY),
    packageWork = bytes / PAGE + waves * WAVE;
  let candidateBands = 0,
    previousBand = -1;
  for (const doc of ids) {
    const band = Math.floor(doc / BAND);
    if (band !== previousBand) candidateBands++;
    previousBand = band;
  }
  const documentPlan = {
    ...plan,
    kind: "documents" as const,
    expectedCandidates: ids.length,
    expectedDocumentBytes: bytes,
    gets: ids.length,
    dependentStages: ids.length ? 2 : 1,
  };
  // Scoring batches nearby bands. A band is not a serial fetch wave. Only a
  // genuinely cheap package prefix can bypass physical-footprint discovery.
  const batchedWaves = Math.ceil(candidateBands / SCORE_LOOKAHEAD_WINDOWS);
  if (
    !ids.length ||
    (waves <= 2 * SCORE_LOOKAHEAD_WINDOWS &&
      packageWork < candidateBands * WAVE) ||
    packageWork < batchedWaves * WAVE
  )
    return {
      ...documentPlan,
      continuationCost: {
        packageBytes: bytes,
        packageGets: ids.length,
        packageWaves: waves,
        pageBytes: 0,
        pageGets: 0,
        candidateBands,
        packageWork,
        blockWork: batchedWaves * WAVE,
        metadataBytes: 0,
        waveEstimateOnly: true,
      },
    };
  const before = reader.stats.bytes,
    layout = await candidateLayout(
      ast,
      terms,
      root,
      reader,
      ids,
      undefined,
      covered,
    ),
    blockWork =
      // There may be fewer than K verified matches. Do not assume ranking
      // bounds will discard half the physical footprint before verification.
      (layout.bytes - layout.residentBytes) / PAGE +
      Math.ceil(layout.candidateBands / SCORE_LOOKAHEAD_WINDOWS) * WAVE,
    continuationCost = {
      packageBytes: bytes,
      packageGets: ids.length,
      packageWaves: waves,
      pageBytes: layout.bytes,
      pageGets: layout.gets,
      candidateBands: layout.candidateBands,
      packageWork,
      blockWork,
      metadataBytes: reader.stats.bytes - before,
    };
  return packageWork < blockWork
    ? { ...documentPlan, continuationCost }
    : { ...plan, kind: "blocks" as const, continuationCost };
}
