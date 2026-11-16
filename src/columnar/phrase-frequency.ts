import type { Node } from "../query/parser.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { Options, PhraseExecution } from "./search.js";
import type { CandidatePackages } from "./packet-execution.js";
import { packageResult } from "./packet-execution.js";
import { filterDocuments } from "./document-filter.js";
import type { Root } from "./format.js";
import { scoreCompleteCandidates } from "./frequency-scores.js";
import { Heap } from "./top-k.js";
import { queryTerms } from "../query/parser.js";
import { positionalMatcher, QueryResourceError } from "../query/evaluate.js";

/** A bounded complete read avoids repeated score-tree windows. Decode only
 * blocks overlapping proven matches, and evaluate BM25 only for those rows.
 * No full-term decoded arrays or ordinary word positions are retained. */
export async function executePhraseFrequencies(
  ast: Node,
  exact: PhraseExecution,
  terms: ReadonlyMap<string, DirectoryTerm>,
  root: Root,
  reader: Reader,
  options: Options,
  packages: CandidatePackages | undefined,
  started: number,
) {
  if (!packages) return;
  const phrases: string[][] = [],
    required = new Set<string>();
  const covered = (n: Node): Node | undefined => {
    if (n.kind === "phrase" && exact.covered(n.terms)) {
      phrases.push(n.terms);
      return n;
    }
    if (n.kind === "term") {
      required.add(n.term);
      // Ordinary AND terms have no requested positions in the block executor.
      // For admitted matches their true, unanchored snippet behavior is `all`.
      return { kind: "all" };
    }
    if (n.kind !== "and") return;
    const left = covered(n.left),
      right = covered(n.right);
    return left && right ? { ...n, left, right } : undefined;
  };
  const snippetAst = covered(ast);
  if (!snippetAst || !phrases.length) return;
  for (const words of phrases) for (const word of words) required.delete(word);
  if (required.size > 65535) return;
  const plans = phrases.map((words) =>
    exact.plans.find((p) => p.words.join("\0") === words.join("\0")),
  );
  if (plans.some((p) => !p || p.membershipOnly)) return;
  const compound = ast.kind !== "phrase",
    contextBytes = plans.reduce((n, p) => n + p!.bytes, 0),
    parts = queryTerms(ast).flatMap((word) => {
      const term = terms.get(word)!;
      return [term.frequencies, ...(term.frequencyParts ?? [])].map((ref) => ({
        term,
        ref,
        required: required.has(word),
      }));
    }),
    frequencyBytes = parts.reduce((n, p) => n + p.ref[2], 0),
    field = options.field ?? "all",
    bound = Math.min(
      ...plans.map((p) =>
        field === "body"
          ? p!.pair.bodyDf
          : field === "title"
            ? p!.pair.titleDf
            : p!.pair.df,
      ),
    ),
    physicalBytes = reader.packetFootprint(parts.map((p) => p.ref));
  // These constrain transfer and active buffers, never the answer. Larger
  // phrases retain the streamed block executor and its exact stopping proofs.
  if (
    !parts.every((p) => p.ref[2]) ||
    frequencyBytes > (compound ? 20 : 16) * 1048576 ||
    physicalBytes > (compound ? 24 : 20) * 1048576 ||
    contextBytes > (compound ? 8 : 4) * 1048576 ||
    bound > (compound ? 262144 : 131072) ||
    frequencyBytes + bound * (required.size ? 19 : 17) > 24 * 1048576
  )
    return;
  const estimatedBlockBytes = parts.reduce(
      (n, p) =>
        n + p.ref[2] * Math.min(1, (bound * 128) / Math.max(1, p.term.df)),
      0,
    ),
    completeCost = physicalBytes / 104857.6 + Math.ceil(parts.length / 6) * 20,
    blockCost =
      Math.max(estimatedBlockBytes, Math.min(physicalBytes, 262144)) /
        104857.6 +
      Math.min(8, Math.ceil(root.count / (8 * 16384))) * 20;
  if (completeCost > blockCost) return;
  const docs = new Uint32Array(bound),
    first = new Uint32Array(bound),
    titleOnly = new Uint8Array(bound),
    boost = options.titleBoost ?? 2,
    matcher = compound
      ? positionalMatcher(
          snippetAst,
          new Map(),
          field,
          undefined,
          { spans: 262144, scratchSpans: 1048576, checks: 100000000 },
          exact.evidence,
          exact.truth,
        )
      : undefined;
  let count = 0;
  for (let lo = 0; lo < root.count; lo += 16384) {
    const hi = Math.min(root.count, lo + 16384);
    await exact.window(lo, hi);
    const mask = exact.mask(ast, field),
      selected: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) selected.push(lo + i);
    const accepted = await filterDocuments(
      Uint32Array.from(selected),
      options.documentFilter,
      reader.stats,
    );
    for (const doc of accepted) {
      if (count >= bound) throw Error("Phrase matches exceed complete pair DF");
      docs[count] = doc;
      let start: number | undefined;
      if (ast.kind === "phrase") {
        const body = exact.evidence(ast.terms, doc, 0)!;
        start = body[0];
        titleOnly[count] = Number(field === "title" || !body.length);
      } else {
        titleOnly[count] = 1;
        if (field !== "title" && options.snippets !== false)
          try {
            start = matcher!.firstBodySpan(doc)?.start;
          } catch (e) {
            if (!(e instanceof QueryResourceError)) throw e;
          }
      }
      first[count] = start ?? 0xffffffff;
      count++;
    }
    exact.release(lo);
  }
  const matches = docs.subarray(0, count),
    present = required.size ? new Uint16Array(count) : undefined,
    scores = await scoreCompleteCandidates(
      matches,
      parts,
      root,
      reader,
      options,
      present,
      compound ? titleOnly : undefined,
      docs.byteLength -
        matches.byteLength +
        first.byteLength +
        titleOnly.byteLength,
    );
  const heap = new Heap(options.limit ?? 20);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (present && present[i] !== required.size) continue;
    const doc = matches[i],
      score = scores[i];
    if (
      options.after &&
      (score > options.after.score ||
        (score === options.after.score && doc <= options.after.doc))
    )
      continue;
    total++;
    heap.add({
      doc,
      score,
      row: 0,
      first: first[i] === 0xffffffff ? undefined : first[i],
      titleOnly: !!titleOnly[i],
    });
  }
  reader.stats.candidates += count;
  const positive = new Set([...terms.values()].map((t) => t.id)),
    display = performance.now(),
    requests = reader.stats.requests,
    bytes = reader.stats.bytes,
    sharedGets = reader.stats.sharedGets,
    memoryHits = reader.stats.memoryHits,
    results = await Promise.all(
      heap.values
        .sort((a, b) => b.score - a.score || a.doc - b.doc)
        .map(async (h) =>
          packageResult(
            await packages.load(h.doc, positive, true),
            h,
            positive,
            options,
          ),
        ),
    );
  reader.stats.metadataMs = performance.now() - display;
  reader.stats.resultRequests = reader.stats.requests - requests;
  reader.stats.resultBytes = reader.stats.bytes - bytes;
  reader.stats.resultSharedGets = reader.stats.sharedGets - sharedGets;
  reader.stats.resultMemoryHits = reader.stats.memoryHits - memoryHits;
  return {
    results,
    ...(options.exactTotal ? { total } : {}),
    generation: root.generation,
    diagnostics: {
      ...reader.stats,
      pair: undefined,
      executor: "exact-phrase-frequencies",
      plan: { kind: "complete-terms", frequencyBytes, positionBytes: 0 },
      wallMs: performance.now() - started,
      retainedPageBytes: reader.memory.pages.bytes,
      retainedDecodedBytes: reader.memory.decoded.bytes,
    },
  };
}
