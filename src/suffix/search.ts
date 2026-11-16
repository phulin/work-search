import { parse, queryTerms, type Node } from "../query/parser.js";
import { tokenizerFor } from "../query/analysis.js";
import { bm25 } from "../query/engine.js";
import { lower } from "../columnar/format.js";
import type { ColumnarIndex, Options } from "../columnar/search.js";
import type { Reader } from "../columnar/storage.js";
import { packagePipeline } from "../columnar/package-batches.js";
import { packageResult, packetPlan } from "../columnar/packet-execution.js";
import { Heap } from "../columnar/top-k.js";
import type { DocumentPackage } from "../columnar/document-package.js";
import { rankSuffix } from "./rank.js";
import { rankSuffixConjunction, scoredConjunction } from "./boolean-rank.js";
import { SuffixEvidence } from "./evidence.js";
import type { SuffixReader } from "./reader.js";
import { scoreCompleteCandidates } from "../columnar/frequency-scores.js";
import { commonWordExclusions } from "../columnar/membership-anchor.js";

/** Optional phrase layer. Disjoint mandatory phrases have additive scores;
 * overlapping words and other Boolean forms retain distinct-word scoring. */
export async function searchWithSuffix(
  engine: ColumnarIndex,
  suffix: SuffixReader,
  q: string,
  reader: Reader,
  options: Options,
  configuration: { bits: 8 | 16; rangeMax: boolean },
) {
  const started = performance.now(),
    root = engine.root;
  if (
    suffix.manifest.corpusGeneration !== root.generation ||
    suffix.manifest.count !== root.count ||
    suffix.manifest.analysis !== root.analysis
  )
    throw Error("Suffix corpus generation mismatch");
  if (
    !engine.directory ||
    !engine.documentDirectory ||
    !root.documentPackages ||
    options.documentFilter ||
    (options.titleBoost ?? 2) !== 2 ||
    options.exactTotal
  )
    return engine.search(q, reader, options);
  const ast = parse(q, options.mode, tokenizerFor(root.analysis)),
    phrases: string[][] = [];
  const visit = (n: Node): void => {
    if (
      n.kind === "phrase" &&
      !phrases.some((p) => p.join("\0") === n.terms.join("\0"))
    )
      phrases.push(n.terms);
    else if (n.kind === "not") visit(n.child);
    else if ("left" in n) {
      visit(n.left);
      visit(n.right);
    }
  };
  visit(ast);
  if (!phrases.length) return engine.search(q, reader, options);
  const terms = await engine.directory.lookup(queryTerms(ast), reader),
    ids = (words: string[]) =>
      Uint32Array.from(words, (w) => terms.get(w)?.id ?? 0),
    scoredWords = queryTerms(ast, true),
    field = options.field ?? "all",
    wanted = new Set([...terms.values()].map((t) => t.id)),
    load = (doc: number, presentation = false) =>
      reader.document(
        root.documentPackages!.generation,
        doc,
        engine.documentDirectory!.lookup(doc),
        wanted,
        presentation,
      ),
    packages = {
      averageBytes: root.documentPackages.averageBytes,
      excludedWords: engine.membership
        ? commonWordExclusions(engine.membership)
        : undefined,
      byteLength: (doc: number) =>
        engine.documentDirectory!.verificationSize(doc),
      load: (doc: number) => load(doc),
    };
  const conjunction = scoredConjunction(ast),
    standalone =
      ast.kind === "phrase" && ast.terms.length >= 2 && ast.terms.length <= 5,
    ordinaryPlan =
      terms.size === queryTerms(ast).length
        ? packetPlan(ast, terms, root, options, packages)
        : undefined;
  // A selective ordinary anchor can disprove a conjunction before fetching
  // its phrase intervals. Compare that path before opening score columns too.
  if (!standalone && ordinaryPlan && ordinaryPlan.kind !== "blocks")
    return engine.search(q, reader, options);
  // Stored scores cover both fields. Field-restricted searches use exact
  // suffix evidence with the ordinary scorer rather than weak all-field bounds.
  if ((standalone || conjunction) && field === "all") {
    const retained = new Map<number, DocumentPackage>(),
      winners = new Heap(options.limit ?? 20);
    let retainedBytes = 0;
    const rescore = async (documents: Uint32Array) => {
        const limit = options.limit ?? 20,
          finish = new Set<number>();
        let extra = 0;
        if (documents.length <= 2 * limit)
          for (const doc of documents) {
            const locator = engine.documentDirectory!.lookup(doc),
              more = Math.max(0, locator.length - packages.byteLength(doc));
            if (locator.length <= 65536 && extra + more <= 1048576) {
              finish.add(doc);
              extra += more;
            }
          }
        const parts = scoredWords.flatMap((name) => {
            const term = terms.get(name);
            return term
              ? [term.frequencies, ...(term.frequencyParts ?? [])].map(
                  (ref) => ({ term, ref }),
                )
              : [];
          }),
          bytes = parts.reduce((n, p) => n + p.ref[2], 0),
          documentBytes = documents.reduce(
            (n, d) =>
              n +
              (finish.has(d)
                ? engine.documentDirectory!.lookup(d).length
                : packages.byteLength(d)),
            0,
          ),
          winnerCount = Math.min(limit, documents.length),
          laterWinners =
            winnerCount * (1 - finish.size / Math.max(1, documents.length)),
          frequencyCost =
            bytes / 104857.6 +
            Math.ceil(parts.length / 6) * 60 +
            scoredWords.reduce((n, w) => n + (terms.get(w)?.df ?? 0), 0) /
              20000 +
            Math.ceil(winnerCount / 6) * 60,
          documentCost =
            documentBytes / 104857.6 +
            Math.ceil(documents.length / 6) * 60 +
            Math.ceil(laterWinners / 6) * 60;
        if (
          parts.length &&
          parts.every((p) => p.ref[2]) &&
          bytes <= 8 * 1048576 &&
          frequencyCost < documentCost
        ) {
          const sorted = documents.slice().sort(),
            scores = await scoreCompleteCandidates(
              sorted,
              parts,
              root,
              reader,
              options,
            );
          suffix.stats.frequencyRescores += documents.length;
          return Float64Array.from(documents, (d) => scores[lower(sorted, d)]);
        }
        const result = new Float64Array(documents.length),
          indices = new Map(Array.from(documents, (d, i) => [d, i]));
        for await (const { item: doc, value: pkg } of packagePipeline(
          documents,
          (d) =>
            finish.has(d)
              ? engine.documentDirectory!.lookup(d).length
              : packages.byteLength(d),
          (d) => load(d, finish.has(d)),
        )) {
          const frequencies = pkg.frequencies();
          let score = 0;
          for (const name of scoredWords) {
            const term = terms.get(name)!;
            if (!term) continue;
            const i = lower(frequencies.ids, term.id),
              present = frequencies.ids[i] === term.id,
              body = present ? frequencies.body[i] : 0,
              title = present ? frequencies.title[i] : 0;
            score +=
              bm25(body, term.df, root.count, pkg.bodyLength, root.avgBody) +
              2 *
                bm25(
                  title,
                  term.df,
                  root.count,
                  pkg.titleLength,
                  root.avgTitle,
                );
          }
          result[indices.get(doc)!] = score;
          if (
            options.after &&
            (score > options.after.score ||
              (score === options.after.score && doc <= options.after.doc))
          )
            continue;
          if (winners.accepts(doc, score)) {
            winners.add({ doc, score, row: doc % 4096 });
            retained.set(doc, pkg);
          }
          const keep = new Set(winners.values.map((h) => h.doc));
          for (const d of retained.keys()) if (!keep.has(d)) retained.delete(d);
          retainedBytes = [...retained.values()].reduce(
            (n, p) => n + p.rawBytes,
            0,
          );
          while (retainedBytes > 4 * 1048576 && retained.size) {
            const [d, p] = retained.entries().next().value!;
            retained.delete(d);
            retainedBytes -= p.rawBytes;
          }
        }
        return result;
      },
      rankOptions = {
        ...configuration,
        limit: options.limit ?? 20,
        after: options.after,
        field,
      },
      ranked =
        standalone && ast.kind === "phrase"
          ? await rankSuffix(suffix, ids(ast.terms), rankOptions, rescore)
          : await rankSuffixConjunction(
              suffix,
              conjunction!.map(ids),
              rankOptions,
              rescore,
            );
    if (ranked) {
      const results = [];
      for await (const { value: result } of packagePipeline(
        ranked,
        (h) => {
          const locator = engine.documentDirectory!.lookup(h.doc);
          return locator.length <= 65536
            ? locator.length
            : packages.byteLength(h.doc);
        },
        async (h) =>
          packageResult(
            retained.get(h.doc) ?? (await load(h.doc, true)),
            h,
            wanted,
            options,
          ),
      ))
        results.push(result);
      // Network completion order must not change deterministic ranking.
      const order = new Map(ranked.map((h, i) => [h.doc, i]));
      results.sort((a, b) => order.get(a.doc)! - order.get(b.doc)!);
      return {
        generation: root.generation,
        total: undefined,
        results,
        diagnostics: {
          ...reader.stats,
          executor: standalone ? "suffix-ranked" : "suffix-boolean-ranked",
          suffix: { ...suffix.stats },
          retainedSuffixWinnerBytes: retainedBytes,
          wallMs: performance.now() - started,
        },
      };
    }
  }
  // Keep cheap complete-term and candidate-document plans before interval I/O.
  // General Boolean ranking retains the original distinct-word term scorer.
  if (ordinaryPlan?.kind === "complete-terms")
    return engine.search(q, reader, options);
  const evidence = new SuffixEvidence();
  await Promise.all(
    phrases.map((words) => evidence.add(words, ids(words), suffix)),
  );
  if (!phrases.some((p) => evidence.covered(p)))
    return engine.search(q, reader, options);
  const result = await engine.search(q, reader, {
    ...options,
    phraseExecution: { generation: root.generation, execution: evidence },
  });
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      executor: "suffix-boolean",
      suffixUnderlyingExecutor: result.diagnostics.executor,
      suffix: { ...suffix.stats },
      wallMs: performance.now() - started,
    },
  };
}
