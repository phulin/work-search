import { positionSpan } from "./positions.js";
import { scoreParameters } from "./scoring.js";
import { filterDocuments, type DocumentFilter } from "./document-filter.js";
import { scoreLookahead } from "./score-lookahead.js";
import { leaves } from "./candidate-layout.js";
import { priceDocuments } from "./continuation.js";
export { leaves } from "./candidate-layout.js";
import { Heap } from "./top-k.js";
import { intersectCursors } from "./numeric-cursor.js";
import { tokenizerFor } from "../query/analysis.js";
import type { DocumentDirectory } from "./document-directory.js";
import type { TermDirectory, DirectoryTerm } from "./term-directory.js";
import {
  executePackets,
  packageResult,
  packetPlan,
  readAnchorDocuments,
  type PacketPlan,
  type CandidatePackages,
} from "./packet-execution.js";
import { renderResults } from "./render.js";
import {
  parse,
  queryTerms,
  positional,
  positionalTerms,
  simplify,
  type Node,
} from "../query/parser.js";
import { positionalMatcher, QueryResourceError } from "../query/evaluate.js";
import type { DecodedPostings } from "../format/codec.js";
import {
  type Root,
  type PairRoot,
  type Term,
  type Branch,
  type Ref,
  type Scores,
  decodeScores,
  decodeScoreColumns,
  lower,
  refAt,
  view,
  unpack,
} from "./format.js";
import { Reader } from "./storage.js";
import { loadDictionary } from "./dictionary.js";
import { verifyForward, type PairBatch } from "./forward.js";
import type { Heads } from "./heads.js";
import { planPairAnchor } from "./pair-evidence.js";
import { readPairAnchor } from "./pair-execution.js";
import { ScoreBatch } from "./score-batch.js";
import { selectCandidates, scoreCandidates, pruneCells } from "./score-scan.js";
import {
  essentialTerms,
  cellBounds,
  deferScoreFetch,
  blocksInCells,
} from "./maxscore.js";
import { lookupRemotePairs } from "./pair-lookup.js";
import {
  planCommonPresence,
  commonWordExclusions,
  loadCommonPresence,
  intersectMembershipAnchor,
  enrichMembershipPositions,
  type MembershipSettings,
} from "./membership-anchor.js";
import {
  planBooleanMembership as planMembershipAnchor,
  readBooleanMembership as readMembershipAnchor,
  booleanMembershipAnchor as membershipAnchor,
} from "./boolean-membership.js";
export interface Options {
  documentFilter?: DocumentFilter;
  mode?: "and" | "or";
  limit?: number;
  field?: "all" | "body" | "title";
  titleBoost?: number;
  after?: { score: number; doc: number };
  metadata?: boolean;
  snippets?: boolean;
  exactTotal?: boolean;
}
export interface ContinuationContext {
  ast: Node;
  terms: Map<string, DirectoryTerm>;
  root: Root;
  reader: Reader;
  options: Options;
  packages?: CandidatePackages;
  plan: PacketPlan;
}
const triAnd = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : 2;
/** Three-valued predicate: 0=false, 1=true, 2=unknown. Negated positional
 * conditions cannot be decided from frequencies, including double negation. */
export function coarse(ast: Node, present: (term: string) => number): number {
  if (ast.kind === "empty") return 0;
  if (ast.kind === "all") return 1;
  if (ast.kind === "term") return present(ast.term);
  if (ast.kind === "phrase")
    return ast.terms.some((t) => present(t) === 0) ? 0 : 2;
  if (ast.kind === "not") {
    const a = coarse(ast.child, present);
    return a === 2 ? 2 : 1 - a;
  }
  const a = coarse(ast.left, present),
    b = coarse(ast.right, present);
  if (ast.kind === "or")
    return a === 1 || b === 1 ? 1 : a === 0 && b === 0 ? 0 : 2;
  if (ast.kind === "except") return triAnd(a, b === 2 ? 2 : 1 - b);
  const c = triAnd(a, b);
  return ast.kind === "near" && c !== 0 ? 2 : c;
}
function compileCoarse(
  ast: Node,
  index: Map<string, number>,
  batches: ScoreBatch[],
  loaded: Uint8Array,
  field: "all" | "body" | "title",
): (d: number) => number {
  if (ast.kind === "empty") return () => 0;
  if (ast.kind === "all") return () => 1;
  if (ast.kind === "term") {
    const j = index.get(ast.term)!;
    if (!loaded[j]) return () => 2;
    const b = batches[j],
      handles = b.handle;
    if (field === "all") return (d) => (handles[d] ? 1 : 0);
    const frequencies = field === "body" ? b.body : b.title;
    return (d) => (handles[d] && frequencies[handles[d] - 1] ? 1 : 0);
  }
  if (ast.kind === "phrase") {
    const terms = ast.terms.map((t) => ({ kind: "term" as const, term: t }));
    const predicates = terms.map((t) =>
      compileCoarse(t, index, batches, loaded, field),
    );
    return (d) => {
      for (let i = 0; i < predicates.length; i++)
        if (!predicates[i](d)) return 0;
      return 2;
    };
  }
  if (ast.kind === "not") {
    const c = compileCoarse(ast.child, index, batches, loaded, field);
    return (d) => {
      const a = c(d);
      return a === 2 ? 2 : 1 - a;
    };
  }
  const left = compileCoarse(ast.left, index, batches, loaded, field),
    right = compileCoarse(ast.right, index, batches, loaded, field);
  if (ast.kind === "or")
    return (d) => {
      const a = left(d);
      if (a === 1) return 1;
      const b = right(d);
      return b === 1 ? 1 : a === 0 && b === 0 ? 0 : 2;
    };
  if (ast.kind === "except")
    return (d) => {
      const a = left(d);
      if (!a) return 0;
      const b = right(d);
      return triAnd(a, b === 2 ? 2 : 1 - b);
    };
  if (ast.kind === "near")
    return (d) => (triAnd(left(d), right(d)) === 0 ? 0 : 2);
  return (d) => triAnd(left(d), right(d));
}
function mandatory(ast: Node): Set<string> {
  if (ast.kind === "term") return new Set([ast.term]);
  if (ast.kind === "phrase") return new Set(ast.terms);
  if (!("left" in ast)) return new Set();
  const a = mandatory(ast.left),
    b = mandatory(ast.right);
  if (ast.kind === "or") return new Set([...a].filter((t) => b.has(t)));
  if (ast.kind === "except") return a;
  return new Set([...a, ...b]);
}
async function* leafStream(
  reader: Reader,
  branch: Branch,
): AsyncGenerator<Branch> {
  if (!branch.height) {
    yield branch;
    return;
  }
  for (const child of await reader.branches(branch.score))
    yield* leafStream(reader, child);
}
export class ColumnarIndex {
  /** A single continuation decision after candidate evidence has arrived.
   * Local experiments override this method to compare identical input sets. */
  protected async chooseContinuation(
    context: ContinuationContext,
  ): Promise<PacketPlan> {
    const { plan, packages } = context,
      anchor = packages?.membership;
    if (!packages?.byteLength || !anchor || plan.kind === "complete-terms")
      return plan;
    const selected = function* () {
      for (const doc of anchor.values())
        if (!packages.presenceFilter || packages.presenceFilter(doc)) yield doc;
    };
    const priced = await priceDocuments(context, selected(), anchor.covered);
    return priced.kind === "documents"
      ? { ...priced, membershipAnchor: anchor }
      : priced;
  }

  constructor(
    readonly root: Root,
    readonly heads?: Heads,
    readonly directory?: TermDirectory,
    readonly packages?: CandidatePackages,
    readonly documentDirectory?: DocumentDirectory,
    readonly membership?: MembershipSettings,
  ) {
    tokenizerFor(root.analysis);
    if (
      membership &&
      (membership.router.metadata.baseGeneration !== root.generation ||
        membership.router.metadata.documents !== root.count ||
        !Number.isInteger(membership.N) ||
        membership.N < 0 ||
        membership.N > 200 ||
        !Number.isInteger(membership.M) ||
        membership.M < 0 ||
        membership.M > 2000)
    )
      throw Error("Invalid complete-pair generation or planner settings");
    if (
      root.format !== "CWS1" ||
      !/^[a-f0-9]{64}$/.test(root.generation) ||
      !root.count ||
      (documentDirectory && documentDirectory.count !== root.count) ||
      (!root.documentPackages &&
        root.documents.length !== Math.ceil(root.count / 4096)) ||
      (root.documentPackages &&
        (!/^[a-f0-9]{64}$/.test(root.documentPackages.generation) ||
          root.documentPackages.count !== root.count ||
          root.documentPackages.averageBytes <= 0)) ||
      (root.objectIds &&
        (root.objectIds.length !== root.objects.length ||
          root.objectIds.some(
            (id, i) =>
              !Number.isInteger(id) ||
              id < 0 ||
              id > 0xffffffff ||
              (i > 0 && id <= root.objectIds![i - 1]),
          )))
    )
      throw Error("Invalid CWS1 root");
  }
  terms(
    names: string[],
    reader: Reader,
    routing: Pick<Root, "hot" | "dictionaries" | "dictionaryHeight"> = this
      .root,
  ) {
    if (routing === this.root && this.directory)
      return this.directory.lookup(names, reader);
    return this.dictionary(names, reader, routing);
  }
  async dictionary<T>(
    names: string[],
    reader: Reader,
    routing: Pick<Root, "dictionaries" | "dictionaryHeight"> & {
      hot: Record<string, T>;
    },
  ) {
    return loadDictionary<T>(names, reader, routing);
  }
  async search(
    q: string,
    reader: Reader,
    options: Options = {},
    pairs?: { root: PairRoot; reader: Reader },
  ) {
    if (this.heads && !this.directory && !options.documentFilter) {
      const ast = parse(q, options.mode, tokenizerFor(this.root.analysis)),
        started = performance.now();
      if (ast.kind === "term") {
        const results = await this.heads.search(ast.term, reader, options);
        if (results)
          return {
            results,
            total: undefined,
            generation: this.root.generation,
            diagnostics: {
              ...reader.stats,
              pair: undefined,
              executor: "certified-head",
              wallMs: performance.now() - started,
              retainedPageBytes: reader.memory.pages.bytes,
              retainedDecodedBytes: reader.memory.decoded.bytes,
            },
          };
      }
    }
    const started = performance.now(),
      original = parse(q, options.mode, tokenizerFor(this.root.analysis)),
      requested = queryTerms(original),
      bundled =
        this.membership && this.directory
          ? await this.directory.lookupBundled(requested)
          : undefined,
      excludedWords = this.membership
        ? commonWordExclusions(this.membership)
        : undefined,
      basePackages =
        this.packages ??
        (this.root.documentPackages
          ? {
              averageBytes: this.root.documentPackages.averageBytes,
              byteLength: this.documentDirectory
                ? (doc: number) =>
                    this.documentDirectory!.lookup(doc).verificationBytes
                : undefined,
              load: (doc: number, wanted?: Set<number>, presentation = false) =>
                reader.document(
                  this.root.documentPackages!.generation,
                  doc,
                  this.documentDirectory?.lookup(doc),
                  wanted,
                  presentation,
                ),
            }
          : undefined),
      preliminary =
        bundled && requested.every((name) => bundled.has(name))
          ? packetPlan(
              original,
              bundled,
              this.root,
              options,
              basePackages ? { ...basePackages, excludedWords } : undefined,
            )
          : undefined,
      membershipRead = this.membership
        ? planMembershipAnchor(
            original,
            this.membership,
            bundled,
            basePackages?.averageBytes,
            options.field,
            preliminary,
            options.exactTotal,
          )
        : undefined,
      provedWords = membershipRead?.provedWords ?? new Set<string>(),
      unigramAnchors = preliminary?.anchors?.filter(
        (name) => !provedWords.has(name),
      ),
      filterAlternative =
        preliminary && membershipRead
          ? {
              ...preliminary,
              expectedCandidates: Math.min(
                preliminary.expectedCandidates,
                membershipRead.expectedCandidates,
              ),
              kind:
                membershipRead.expectedCandidates <= 512 &&
                membershipRead.expectedCandidates *
                  (basePackages?.averageBytes ?? Infinity) <=
                  8 * 1048576
                  ? ("documents" as const)
                  : preliminary.kind,
            }
          : preliminary,
      presenceRanks = this.membership
        ? planCommonPresence(
            mandatory(original),
            this.membership,
            provedWords,
            filterAlternative,
            basePackages?.averageBytes ?? 16384,
            options.exactTotal ?? false,
          )
        : [],
      termRequest = bundled
        ? this.terms(
            requested.filter((name) => !bundled.has(name)),
            reader,
          ).then((terms) => {
            for (const [name, term] of bundled) terms.set(name, term);
            return terms;
          })
        : this.terms(requested, reader),
      [terms, selection, presence, unigramCandidates] = await Promise.all([
        termRequest,
        membershipRead && this.membership
          ? readMembershipAnchor(membershipRead, reader, this.membership)
          : undefined,
        this.membership
          ? loadCommonPresence(presenceRanks, reader, this.membership)
          : [],
        membershipRead &&
        preliminary?.kind === "documents" &&
        unigramAnchors?.length &&
        bundled
          ? readAnchorDocuments(
              unigramAnchors,
              bundled,
              reader,
              options.field ?? "all",
              this.root,
            )
          : undefined,
      ]),
      ast = simplify(original, (t) => terms.has(t)),
      names = queryTerms(ast),
      positive = new Set(queryTerms(ast, true)),
      positions = positional(ast),
      wantedPositions = positionalTerms(ast),
      limit = options.limit ?? 20,
      boost = options.titleBoost ?? 2,
      field = options.field ?? "all",
      heap = new Heap(limit);
    reader.stats.optionalReadAlternative = preliminary?.kind ?? "cold-metadata";
    reader.stats.plannedPairPackets = membershipRead?.pairs.length ?? 0;
    reader.stats.plannedPresenceLists = presenceRanks.length;
    reader.stats.estimatedPairCandidates =
      membershipRead?.expectedCandidates ?? 0;
    let loadedMembership = selection
      ? intersectMembershipAnchor(
          membershipAnchor(
            selection,
            new Map([...terms].map(([name, t]) => [name, t.id])),
            field,
          ),
          unigramCandidates,
        )
      : undefined;
    if (unigramCandidates) {
      reader.stats.anchorUnigramCandidates = unigramCandidates.length;
      reader.stats.anchorIntersectionCandidates = loadedMembership?.count ?? 0;
      reader.stats.anchorBufferBytes +=
        unigramCandidates.buffer.byteLength +
        (loadedMembership?.count ?? 0) * 4;
    }
    reader.stats.membershipCandidates = loadedMembership?.count ?? 0;
    const presenceFilter = presence.length
      ? (doc: number) => {
          for (let i = 0; i < presence.length; i++)
            if (!presence[i].has(doc, field)) return false;
          return true;
        }
      : undefined;
    let packetCandidates: Uint32Array | undefined;
    if (
      selection &&
      loadedMembership &&
      [...selection.selections.values()].some((s) =>
        s.records.some((r) => r.positionDirectory),
      )
    ) {
      const docs = Uint32Array.from(
          [...loadedMembership.values()].filter(
            (doc) => !presenceFilter || presenceFilter(doc),
          ),
        ),
        verificationBytes = basePackages?.byteLength
          ? docs.reduce((n, doc) => n + basePackages.byteLength!(doc), 0)
          : docs.length * (basePackages?.averageBytes ?? 16384);
      const selections = [...selection.selections.values()],
        budget = Math.floor(
          Math.min(4 * 1048576, verificationBytes / 2) / selections.length,
        );
      await Promise.all(
        selections.map((s) =>
          enrichMembershipPositions(s, docs, reader, budget),
        ),
      );
      loadedMembership = intersectMembershipAnchor(
        membershipAnchor(
          selection,
          new Map([...terms].map(([name, t]) => [name, t.id])),
          field,
        ),
        unigramCandidates,
      );
      reader.stats.membershipCandidates = loadedMembership.count;
    }
    const packages = basePackages
      ? {
          ...basePackages,
          fallbackCandidates: (docs: Uint32Array) => {
            packetCandidates = docs;
          },
          excludedWords,
          presenceFilter,
          membership: loadedMembership,
        }
      : undefined;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isFinite(boost) ||
      boost < 0 ||
      boost > 20 ||
      !["all", "body", "title"].includes(field)
    )
      throw Error("Invalid search options");
    if (
      options.after &&
      (!Number.isFinite(options.after.score) ||
        !Number.isInteger(options.after.doc) ||
        options.after.doc < 0 ||
        options.after.doc >= this.root.count)
    )
      throw Error("Invalid search cursor");
    let planned: PacketPlan | undefined;
    let queryRoot = this.root;
    if (this.directory) {
      planned = packetPlan(
        ast,
        terms as Map<string, DirectoryTerm>,
        this.root,
        options,
        packages,
      );
      queryRoot = await lookupRemotePairs(
        ast,
        terms as Map<string, DirectoryTerm>,
        this.root,
        reader,
        planned,
      );
      if (queryRoot !== this.root)
        planned = packetPlan(
          ast,
          terms as Map<string, DirectoryTerm>,
          queryRoot,
          options,
          packages,
        );
      planned = await this.chooseContinuation({
        ast,
        terms: terms as Map<string, DirectoryTerm>,
        root: queryRoot,
        reader,
        options,
        packages,
        plan: planned,
      });
      const result = await executePackets(
        ast,
        terms as Map<string, DirectoryTerm>,
        queryRoot,
        reader,
        options,
        packages,
        planned,
      );
      if (result) return result;
    }
    const scoring = names
        .map((n, i) => (positive.has(n) ? i : -1))
        .filter((i) => i >= 0),
      required = mandatory(ast),
      ordinaryRequired = [...required].filter((n) => !excludedWords?.has(n)),
      anchor = (ordinaryRequired.length ? ordinaryRequired : [...required])
        .map((n) => terms.get(n)!)
        .sort((a, b) => a.df - b.df)[0];
    let bands: number[] = [],
      pairCandidates = packetCandidates,
      pairAnchor: Term | undefined,
      pairBatch: PairBatch | undefined,
      pairOffset = 0,
      context: Awaited<ReturnType<typeof readPairAnchor>> | undefined;
    // Four document-directory windows per numeric batch amortize the two score
    // phases without adding another remote stage per 4096 documents.
    const BAND = 16384,
      LOOKAHEAD = 8;
    if (packetCandidates) {
      reader.stats.anchorBufferBytes += packetCandidates.buffer.byteLength;
      for (const doc of packetCandidates) {
        const band = Math.floor(doc / BAND);
        if (bands.at(-1) !== band) bands.push(band);
      }
    }
    if (loadedMembership) {
      wantedPositions.clear();
      for (const name of positionalTerms(ast, loadedMembership.covered))
        wantedPositions.add(name);
      const cursor = loadedMembership.cursor();
      for (let doc = cursor.next(); doc !== Infinity; doc = cursor.next()) {
        const band = Math.floor(doc / BAND);
        if (bands.at(-1) !== band) bands.push(band);
      }
    }
    if (pairs && !pairCandidates) {
      if (
        pairs.root.baseGeneration !== this.root.generation ||
        pairs.root.count !== this.root.count
      )
        throw Error("Pair generation mismatch");
      const phrases = (n: Node): string[][] => {
        if (n.kind === "phrase") return [n.terms];
        if (!("left" in n)) return [];
        const a = phrases(n.left),
          b = phrases(n.right);
        if (n.kind === "or")
          return a.filter((x) =>
            b.some((y) => JSON.stringify(x) === JSON.stringify(y)),
          );
        if (n.kind === "except") return a;
        return [...a, ...b];
      };
      const names = phrases(ast).flatMap((ts) =>
          ts
            .slice(1)
            .map((b, i) => `@${terms.get(ts[i])?.id}:${terms.get(b)?.id}`),
        ),
        plans = await this.terms(names, pairs.reader, pairs.root);
      // A strategy memory budget, never a candidate limit: larger pairs fall
      // back to buffered positional intersection over the complete corpus.
      pairAnchor = [...plans.values()]
        .filter((p) => p.df <= 65536 && (!anchor || p.df < anchor.df))
        .sort((a, b) => a.df - b.df)[0];
      if (pairAnchor) {
        const bs = await leaves(
            pairs.reader,
            pairAnchor.tree,
            0,
            this.root.count,
          ),
          docs = new Uint32Array(pairAnchor.df),
          body = new Uint32Array(pairAnchor.df),
          title = new Uint32Array(pairAnchor.df),
          handles = new Uint32Array(pairAnchor.df);
        let n = 0;
        for (let i = 0; i < bs.length; i += 64) {
          const raw = await pairs.reader.many(
            bs.slice(i, i + 64).map((b) => b.score),
          );
          raw.forEach((b, j) => {
            const s = pairs.reader.decoded(
              bs[i + j].score,
              b,
              decodeScoreColumns,
            );
            for (let r = 0; r < s.docs.length; r++)
              if (field === "all" || s[field][r]) {
                docs[n] = s.docs[r];
                body[n] = s.body[r];
                title[n] = s.title[r];
                handles[n] = ((i + j) << 8) | r;
                n++;
              }
          });
        }
        pairCandidates = docs.subarray(0, n);
        pairBatch = {
          docs: pairCandidates,
          body: body.subarray(0, n),
          title: title.subarray(0, n),
          handles: handles.subarray(0, n),
          branches: bs,
        };
        const selectedBands = new Set<number>();
        for (const d of pairCandidates) selectedBands.add(Math.floor(d / BAND));
        bands = [...selectedBands];
        if (ast.kind === "phrase")
          pairOffset = ast.terms
            .slice(1)
            .findIndex(
              (t, i) =>
                plans.get(
                  `@${terms.get(ast.terms[i])!.id}:${terms.get(t)!.id}`,
                ) === pairAnchor,
            );
      }
    }
    if (!loadedMembership && !pairCandidates && queryRoot.positionalPairs) {
      const ids = new Map([...terms].map(([name, t]) => [name, t.id])),
        selected = planPairAnchor(ast, ids, queryRoot);
      if (selected) {
        context = await readPairAnchor(
          selected.pairs,
          selected.words,
          ids,
          field,
          reader,
        );
        pairCandidates = context.candidates;
        wantedPositions.clear();
        for (const name of positionalTerms(ast, context.covered))
          wantedPositions.add(name);
        for (const doc of pairCandidates) {
          const band = Math.floor(doc / BAND);
          if (bands.at(-1) !== band) bands.push(band);
        }
      }
    }
    if (
      !pairCandidates &&
      ast.kind !== "empty" &&
      anchor &&
      anchor.df < this.root.count / 16 &&
      (!loadedMembership || anchor.df < loadedMembership.count)
    ) {
      const selected = new Set<number>();
      const selectedDocs =
        anchor.df <= 65536 ? new Uint32Array(anchor.df) : undefined;
      let selectedCount = 0;
      let batch: Branch[] = [];
      // Bounded chunks, even for a large corpus; never materialize all plans of a common term.
      const flush = async () => {
        const beforeIO = reader.stats.requests + reader.stats.sharedGets;
        const scores = await Promise.all(
          batch.map((b) => reader.load(b.score, decodeScoreColumns)),
        );
        if (reader.stats.requests + reader.stats.sharedGets > beforeIO)
          reader.stats.anchorIOWaves++;
        for (const s of scores)
          for (let r = 0; r < s.docs.length; r++)
            if (
              (field === "all" || s[field][r]) &&
              (!loadedMembership || loadedMembership.has(s.docs[r]))
            ) {
              selected.add(Math.floor(s.docs[r] / BAND));
              if (selectedDocs) selectedDocs[selectedCount++] = s.docs[r];
            }
        batch = [];
      };
      for await (const leaf of leafStream(reader, anchor.tree)) {
        batch.push(leaf);
        if (batch.length === 64) await flush();
      }
      if (batch.length) await flush();
      if (selectedDocs)
        pairCandidates = selectedDocs.subarray(0, selectedCount);
      bands = [...selected].sort((a, b) => a - b);
    } else if (!loadedMembership && !pairCandidates && ast.kind !== "empty")
      bands = Array.from(
        { length: Math.ceil(this.root.count / BAND) },
        (_, i) => i,
      );
    let total = 0;
    const nameIndex = new Map(names.map((n, i) => [n, i])),
      requiredIndices = [...required].map((name) => nameIndex.get(name)!);
    const scoreBatches = names.map(
        (name) =>
          new ScoreBatch(BAND, scoreParameters(terms.get(name)!.df, this.root)),
      ),
      candidateBuffer = new Uint32Array(BAND),
      scoreBuffer = new Float64Array(BAND);
    let window: Branch[][][] = [];
    const membershipCursor = loadedMembership?.cursor();
    let membershipDoc = membershipCursor?.next() ?? Infinity;
    // Sparse candidates should probe restart blocks directly. A sequential
    // presence scan earns its cost only when candidate coverage is broad.
    const probePresence =
      (pairCandidates?.length ?? loadedMembership?.count ?? this.root.count) <
      this.root.count / 16;
    const presenceCursor =
      presence.length && !probePresence
        ? intersectCursors(presence.map((record) => record.cursor(field)))
        : undefined;
    let presenceDoc = presenceCursor?.next() ?? Infinity;
    const candidateWindows = new Map<
      number,
      { cells: Uint8Array; mask: Uint8Array | undefined }
    >();
    const candidateWindow = async (band: number) => {
      const old = candidateWindows.get(band);
      if (old) return old;
      const lo = band * BAND,
        hi = Math.min(this.root.count, lo + BAND),
        size = hi - lo;
      const cells = new Uint8Array(Math.ceil(size / 128)).fill(1);
      let candidateMask: Uint8Array | undefined;
      if (loadedMembership) {
        candidateMask = new Uint8Array(size);
        cells.fill(0);
        // Bands advance in document order. Reuse the membership cursor rather
        // than searching its restart table for every document in every band.
        while (membershipDoc < lo) membershipDoc = membershipCursor!.next();
        while (membershipDoc < hi) {
          const d = membershipDoc - lo;
          candidateMask[d] = 1;
          cells[d >>> 7] = 1;
          membershipDoc = membershipCursor!.next();
        }
      }
      if (pairCandidates) {
        const previousMask = candidateMask;
        candidateMask = new Uint8Array(size);
        cells.fill(0);
        for (
          let i = lower(pairCandidates, lo);
          i < pairCandidates.length && pairCandidates[i] < hi;
          i++
        ) {
          if (previousMask && !previousMask[pairCandidates[i] - lo]) continue;
          cells[(pairCandidates[i] - lo) >>> 7] = 1;
          candidateMask[pairCandidates[i] - lo] = 1;
        }
      }
      if (presenceFilter) {
        if (probePresence) {
          candidateMask ??= new Uint8Array(size).fill(1);
          cells.fill(0);
          for (let d = 0; d < size; d++)
            if (candidateMask[d] && presenceFilter(lo + d)) cells[d >>> 7] = 1;
            else candidateMask[d] = 0;
        } else {
          const previousMask = candidateMask;
          candidateMask = new Uint8Array(size);
          cells.fill(0);
          while (presenceDoc < lo) presenceDoc = presenceCursor!.next();
          while (presenceDoc < hi) {
            const d = presenceDoc - lo;
            if (!previousMask || previousMask[d]) {
              candidateMask[d] = 1;
              cells[d >>> 7] = 1;
            }
            presenceDoc = presenceCursor!.next();
          }
        }
      }

      if (options.documentFilter) {
        const possible = new Uint32Array(size);
        let n = 0;
        for (let d = 0; d < size; d++)
          if (!candidateMask || candidateMask[d]) possible[n++] = lo + d;
        const selected = await filterDocuments(
          possible.subarray(0, n),
          options.documentFilter,
          reader.stats,
        );
        candidateMask = new Uint8Array(size);
        cells.fill(0);
        for (const doc of selected) {
          candidateMask[doc - lo] = 1;
          cells[(doc - lo) >>> 7] = 1;
        }
      }
      const value = { cells, mask: candidateMask };
      candidateWindows.set(band, value);
      return value;
    };
    const candidateLookahead =
      (positions || !!options.documentFilter) &&
      scoring.length > 0 &&
      !!(loadedMembership || pairCandidates || options.documentFilter);
    let lookaheadRefs: Ref[][] = [],
      prefetchedThrough = 0;
    for (let bandIndex = 0; bandIndex < bands.length; bandIndex++) {
      const band = bands[bandIndex];
      // Candidate masks are generated in document order and reused by exact
      // execution. Lookahead may fetch scores, never positional payloads.
      if (
        (!positions || scoring.length > 0) &&
        (bands.length >= 8 || candidateLookahead) &&
        bandIndex % LOOKAHEAD === 0
      ) {
        const nextBands = bands.slice(bandIndex, bandIndex + LOOKAHEAD);
        if (nextBands.at(-1)! - nextBands[0] === nextBands.length - 1) {
          const combined = await Promise.all(
            names.map((name) =>
              leaves(
                reader,
                terms.get(name)!.tree,
                nextBands[0] * BAND,
                Math.min(this.root.count, (nextBands.at(-1)! + 1) * BAND),
              ),
            ),
          );
          window = nextBands.map((next) =>
            combined.map((bs) =>
              bs.filter(
                (b) =>
                  b.last >= next * BAND &&
                  b.first < Math.min(this.root.count, (next + 1) * BAND),
              ),
            ),
          );
        } else {
          window = await Promise.all(
            nextBands.map((next) =>
              Promise.all(
                names.map((name) =>
                  leaves(
                    reader,
                    terms.get(name)!.tree,
                    next * BAND,
                    Math.min(this.root.count, (next + 1) * BAND),
                  ),
                ),
              ),
            ),
          );
        }
        if (candidateLookahead)
          await Promise.all(nextBands.map((next) => candidateWindow(next)));
        const groups = window.map((bs, i) => {
          if (
            coarse(ast, (name) => (bs[names.indexOf(name)].length ? 2 : 0)) ===
            0
          )
            return [];
          let upper = 0;
          for (const j of scoring) {
            let b = 0,
              t = 0;
            for (const block of bs[j]) {
              b = Math.max(b, block.b);
              t = Math.max(t, block.t);
            }
            upper +=
              (field !== "title" ? b : 0) + (field !== "body" ? boost * t : 0);
          }
          upper *= 1 + Number.EPSILON * 32;
          const first = bands[bandIndex + i] * BAND;
          if (
            !options.exactTotal &&
            heap.threshold &&
            (upper < heap.threshold.score ||
              (upper === heap.threshold.score && first > heap.threshold.doc))
          )
            return [];
          const perTermBounds = bs.map((blocks) => {
            let b = 0,
              t = 0;
            for (const block of blocks) {
              b = Math.max(b, block.b);
              t = Math.max(t, block.t);
            }
            return (
              (field !== "title" ? b : 0) + (field !== "body" ? boost * t : 0)
            );
          });
          // Use the same current verified threshold/cell proof as execution.
          // Later stronger thresholds can make this speculative, never required.
          const cells = candidateLookahead
            ? candidateWindows.get(bands[bandIndex + i])!.cells
            : new Uint8Array(
                Math.ceil(Math.min(BAND, this.root.count - first) / 128),
              ).fill(1);
          if (!options.exactTotal && heap.threshold)
            pruneCells(
              cells,
              cellBounds(
                bs,
                first,
                Math.min(BAND, this.root.count - first),
                field,
                boost,
              ),
              scoring,
              first,
              heap.threshold,
            );
          const selected = blocksInCells(bs, cells, first),
            essential = essentialTerms(
              selected,
              perTermBounds,
              scoring,
              requiredIndices,
              BAND,
              heap.threshold?.score,
              options.exactTotal ?? false,
            );
          const lazy = deferScoreFetch(selected, essential, BAND, (ref) =>
            reader.resident(ref),
          );
          return (
            lazy ? essential!.flatMap((j) => selected[j]) : selected.flat()
          ).map((block) => block.score);
        });
        if (candidateLookahead) lookaheadRefs = groups;
        else {
          const refs = groups.flat(),
            footprint = reader.packetFootprint(refs);
          if (
            footprint <= Math.min(4 * 1048576, reader.memory.pages.limit / 3)
          ) {
            const before = reader.stats.bytes;
            reader.stats.prefetchWindows++;
            reader.stats.prefetchTransferBytes += footprint;
            reader.stats.maxPrefetchFootprintBytes = Math.max(
              reader.stats.maxPrefetchFootprintBytes,
              footprint,
            );
            await reader.prefetchScores(refs);
            reader.stats.prefetchOriginBytes += reader.stats.bytes - before;
          }
        }
      }
      if (candidateLookahead && bandIndex >= prefetchedThrough) {
        const batch = scoreLookahead(
          lookaheadRefs.slice(bandIndex % LOOKAHEAD),
          Math.min(4 * 1048576, reader.memory.pages.limit / 3),
          (refs) => reader.packetFootprint(refs),
        );
        prefetchedThrough = bandIndex + Math.max(1, batch.windows);
        if (batch.refs.length && !batch.partial && batch.windows > 1) {
          const before = reader.stats.bytes;
          reader.stats.prefetchWindows++;
          reader.stats.prefetchTransferBytes += batch.bytes;
          reader.stats.maxPrefetchFootprintBytes = Math.max(
            reader.stats.maxPrefetchFootprintBytes,
            batch.bytes,
          );
          await reader.prefetchScores(batch.refs);
          reader.stats.prefetchOriginBytes += reader.stats.bytes - before;
        }
      }
      const lo = band * BAND,
        hi = Math.min(this.root.count, lo + BAND),
        size = hi - lo;
      const blocks =
        window[bandIndex % LOOKAHEAD] ??
        (await Promise.all(
          names.map((n) => leaves(reader, terms.get(n)!.tree, lo, hi)),
        ));
      if (coarse(ast, (n) => (blocks[names.indexOf(n)].length ? 2 : 0)) === 0) {
        reader.stats.skippedRanges++;
        candidateWindows.delete(band);
        continue;
      }
      const bounds = blocks.map((bs) => {
        let b = 0,
          t = 0;
        for (const x of bs) {
          b = Math.max(b, x.b);
          t = Math.max(t, x.t);
        }
        return (field !== "title" ? b : 0) + (field !== "body" ? boost * t : 0);
      });
      // Round the sum outward: equality is always visited, preserving deterministic ties.
      const upper =
        scoring.reduce((s, j) => s + bounds[j], 0) * (1 + Number.EPSILON * 32);
      if (
        !options.exactTotal &&
        heap.threshold &&
        (upper < heap.threshold.score ||
          (upper === heap.threshold.score && lo > heap.threshold.doc))
      ) {
        reader.stats.skippedRanges++;
        candidateWindows.delete(band);
        continue;
      }
      const { cells, mask: candidateMask } = await candidateWindow(band);
      candidateWindows.delete(band);
      const localBounds = cellBounds(blocks, lo, size, field, boost);
      if (!options.exactTotal && heap.threshold)
        pruneCells(cells, localBounds, scoring, lo, heap.threshold);
      if (
        loadedMembership ||
        pairCandidates ||
        options.documentFilter ||
        heap.threshold
      ) {
        const filtered = blocksInCells(blocks, cells, lo);
        for (let j = 0; j < blocks.length; j++) blocks[j] = filtered[j];
      }
      if (candidateMask)
        reader.inspectCandidateBlocks?.(blocks, candidateMask, lo);
      const essential = essentialTerms(
          blocks,
          bounds,
          scoring,
          requiredIndices,
          size,
          heap.threshold?.score,
          options.exactTotal ?? false,
        ),
        loaded = new Uint8Array(names.length),
        initial = essential ?? names.map((_, j) => j),
        columns = scoreBatches.map((batch) => {
          batch.reset(lo, size);
          return batch.columns();
        }),
        candidates = candidateBuffer,
        values = scoreBuffer;
      let nc = 0,
        fetchedBytes = 0;
      const append = (j: number, k: number, raw: Uint8Array) => {
        const n = scoreBatches[j].append(raw, k);
        reader.stats.postings += n;
        reader.stats.scorePostingsDecoded += n;
        reader.stats.scoreBlocksDecoded++;
        reader.observeDecoded(blocks[j][k].score, raw.length);
      };
      const allRefs = blocks.flatMap((bs) => bs.map((b) => b.score)),
        lazyFetch = deferScoreFetch(blocks, essential, size, (ref) =>
          reader.resident(ref),
        );
      if (essential) reader.stats.lazyScoreWindows++;
      else reader.stats.eagerScoreWindows++;
      if (!lazyFetch) reader.stats.eagerScoreFetchWindows++;
      const data = await reader.scores(
        lazyFetch
          ? initial.flatMap((j) => blocks[j].map((b) => b.score))
          : allRefs,
        true,
      );
      fetchedBytes += data.reduce((n, raw) => n + raw.length, 0);
      const offsets = blocks.map((_, j) =>
        blocks.slice(0, j).reduce((n, bs) => n + bs.length, 0),
      );
      let p = 0;
      for (const j of initial) {
        for (let k = 0; k < blocks[j].length; k++)
          append(j, k, data[lazyFetch ? p++ : offsets[j] + k]);
        loaded[j] = 1;
        columns[j] = scoreBatches[j].columns();
      }
      const selected = selectCandidates(
        lo,
        size,
        cells,
        candidateMask,
        compileCoarse(ast, nameIndex, scoreBatches, loaded, field),
        scoreBatches,
        scoring,
        essential,
        loaded,
        localBounds,
        field !== "title",
        field !== "body" ? boost : 0,
        essential ? heap.threshold : undefined,
        candidates,
      );
      nc = selected.count;
      reader.stats.partialScoreRejected += selected.rejected;
      // Candidates are sorted numeric IDs. Select each deferred block once by
      // interval overlap, then fetch the union in one coalesced parallel wave.
      const deferred: number[][] = blocks.map((bs, j) =>
        loaded[j]
          ? []
          : bs.flatMap((b, k) => {
              const at = lower(candidates.subarray(0, nc), b.first);
              return at < nc && candidates[at] <= b.last ? [k] : [];
            }),
      );
      const tail = lazyFetch
        ? await reader.scores(
            deferred.flatMap((ks, j) => ks.map((k) => blocks[j][k].score)),
            true,
          )
        : [];
      fetchedBytes += tail.reduce((n, raw) => n + raw.length, 0);
      p = 0;
      for (let j = 0; j < blocks.length; j++)
        if (!loaded[j]) {
          for (const k of deferred[j])
            append(j, k, lazyFetch ? tail[p++] : data[offsets[j] + k]);
          loaded[j] = 1;
          columns[j] = scoreBatches[j].columns();
        }
      const scored = scoreCandidates(
        lo,
        nc,
        compileCoarse(ast, nameIndex, scoreBatches, loaded, field),
        scoreBatches,
        scoring,
        field !== "title",
        field !== "body" ? boost : 0,
        options.after,
        options.exactTotal ? undefined : heap.threshold,
        candidates,
        values,
      );
      nc = scored.count;
      reader.stats.candidates += scored.visited;
      const positionData = new Map<string, Uint8Array>();
      // Very sparse phrases use compact forward IDs. Broad phrases/proximity
      // retain the buffered positional path and avoid per-document forward I/O.
      const forward =
        ast.kind === "phrase" &&
        field !== "title" &&
        pairBatch &&
        pairs &&
        pairBatch.docs.length <= 128 &&
        nc
          ? await verifyForward(
              reader,
              pairs.reader,
              pairBatch,
              candidates.subarray(0, nc),
              ast.terms.map((t) => terms.get(t)!.id),
              pairOffset,
            )
          : undefined;
      const loadPositions = async (from: number, to: number) => {
        positionData.clear();
        const refs = new Map<string, Ref>();
        for (const n of wantedPositions) {
          const j = nameIndex.get(n);
          if (j === undefined) continue;
          const c = columns[j];
          for (let i = from; i < to; i++) {
            if (
              (forward && forward[i] !== -2) ||
              (!options.exactTotal && !heap.accepts(candidates[i], values[i]))
            )
              continue;
            const row = c.handle[candidates[i] - lo] - 1;
            if (row >= 0) {
              const ref = blocks[j][c.blockIndex[row]].positions;
              refs.set(reader.key(ref), ref);
            }
          }
        }
        const beforeIO = reader.stats.requests + reader.stats.sharedGets;
        const raw = await reader.many([...refs.values()]);
        if (reader.stats.requests + reader.stats.sharedGets > beforeIO)
          reader.stats.positionIOWaves++;
        let i = 0;
        for (const key of refs.keys()) positionData.set(key, raw[i++]);
      };
      const scratch = names.map(() => ({
        doc: -1,
        fields: [undefined, undefined] as (Uint32Array | undefined)[],
      }));
      const direct = (name: string, doc: number, f: number) => {
        const j = nameIndex.get(name);
        if (j === undefined) return;
        const c = columns[j],
          row = c.handle[doc - lo] - 1;
        if (row < 0) return;
        const s = scratch[j];
        if (s.doc !== doc) {
          s.fields[0] = s.fields[1] = undefined;
          s.doc = doc;
        }
        if (!s.fields[f]) {
          const ref = blocks[j][c.blockIndex[row]].positions,
            raw = positionData.get(reader.key(ref));
          if (!raw) return;
          s.fields[f] = positionSpan(
            raw,
            c.blockRow[row],
            f,
            f ? c.title[row] : c.body[row],
            (bytes) => {
              reader.stats.decodedBytes += bytes;
            },
          );
          reader.stats.positionIntegers += s.fields[f]!.length;
        }
        return s.fields[f];
      };
      const lists = new Map<string, DecodedPostings>(
        names.map((n, j) => [
          n,
          {
            docs: columns[j].docs,
            body: columns[j].body,
            title: columns[j].title,
            bytes: new Uint8Array(0),
          },
        ]),
      );
      const match = positions
        ? positionalMatcher(
            ast,
            lists,
            field,
            direct,
            {
              spans: 262144,
              scratchSpans: 1048576,
              checks: 100000000,
            },
            loadedMembership?.evidence ?? context?.evidence,
          )
        : undefined;
      for (let i = 0; i < nc; i++) {
        if (positions && i % 256 === 0)
          await loadPositions(i, Math.min(nc, i + 256));
        const doc = candidates[i],
          score = values[i];
        if (!options.exactTotal && !heap.accepts(doc, score)) continue;
        if (forward && forward[i] === -1) continue;
        if (match && (!forward || forward[i] === -2) && !match(doc)) continue;
        total++;
        if (!heap.accepts(doc, score)) continue;
        let selected = -1;
        for (const j of scoring) {
          const c = columns[j],
            r = c.handle[doc - lo] - 1;
          if (r >= 0 && c.body[r]) {
            selected = j;
            break;
          }
        }
        const hasScoringBody = selected >= 0;
        if (selected < 0)
          selected = columns.findIndex((c) => !!c.handle[doc - lo]);
        const c = columns[selected],
          r = c ? c.handle[doc - lo] - 1 : -1;
        let first: number | undefined =
          forward && forward[i] >= 0 ? forward[i] : undefined;
        if (
          first === undefined &&
          match &&
          field !== "title" &&
          options.snippets !== false
        ) {
          if (ast.kind === "phrase" && !context) {
            const ps = ast.terms.map((n) => direct(n, doc, 0) ?? []);
            let anchor = 0;
            for (let j = 1; j < ps.length; j++)
              if (ps[j].length < ps[anchor].length) anchor = j;
            for (let j = 0; j < ps[anchor].length; j++) {
              const start = ps[anchor][j] - anchor;
              if (
                start >= 0 &&
                ps.every((a, k) => a[lower(a, start + k)] === start + k)
              ) {
                first = start;
                break;
              }
            }
          } else {
            try {
              first = match.firstBodySpan(doc)?.start;
            } catch (e) {
              if (!(e instanceof QueryResourceError)) throw e;
            }
          }
        }
        heap.add({
          doc,
          score,
          branch: r >= 0 ? blocks[selected][c.blockIndex[r]] : undefined,
          row: r >= 0 ? c.blockRow[r] : doc % 4096,
          first,
          titleOnly:
            field === "title" ||
            (ast.kind === "phrase" && first === undefined) ||
            (scoring.length > 0 && !hasScoringBody),
        });
      }
      const active =
        scoreBatches.reduce((s, batch) => s + batch.bytes, 0) +
        fetchedBytes +
        candidates.byteLength +
        values.byteLength +
        [...positionData.values()].reduce((s, b) => s + b.length, 0);
      reader.stats.peakActiveBufferBytes = Math.max(
        reader.stats.peakActiveBufferBytes,
        active + reader.stats.anchorBufferBytes,
      );
    }
    const ranked = heap.values.sort(
        (a, b) => b.score - a.score || a.doc - b.doc,
      ),
      display = performance.now(),
      resultRequests = reader.stats.requests,
      resultBytes = reader.stats.bytes,
      resultSharedGets = reader.stats.sharedGets,
      resultMemoryHits = reader.stats.memoryHits,
      positiveIds = new Set([...positive].map((n) => terms.get(n)!.id)),
      results = packages
        ? await Promise.all(
            ranked.map(async (h) =>
              packageResult(
                await packages.load(h.doc, positiveIds, true),
                h,
                positiveIds,
                options,
              ),
            ),
          )
        : await renderResults(this.root, reader, ranked, options, ast);
    reader.stats.metadataMs = performance.now() - display;
    reader.stats.resultRequests = reader.stats.requests - resultRequests;
    reader.stats.resultBytes = reader.stats.bytes - resultBytes;
    reader.stats.resultSharedGets = reader.stats.sharedGets - resultSharedGets;
    reader.stats.resultMemoryHits = reader.stats.memoryHits - resultMemoryHits;
    return {
      results,
      ...(options.exactTotal ? { total } : {}),
      generation: this.root.generation,
      diagnostics: {
        ...reader.stats,
        pair: pairs
          ? {
              ...pairs.reader.stats,
              candidates: pairAnchor ? pairCandidates?.length : undefined,
              used: !!pairAnchor,
            }
          : undefined,
        plan: planned
          ? {
              ...planned,
              kind: "blocks",
              fallbackFrom:
                planned.kind !== "blocks" ? planned.kind : undefined,
            }
          : undefined,
        positionalPairCandidates:
          loadedMembership?.count ?? context?.candidates.length,
        executor: loadedMembership
          ? "membership-blocks"
          : context
            ? "pair-blocks"
            : pairAnchor
              ? "positional-pair"
              : anchor && anchor.df < this.root.count / 16
                ? "selective"
                : "block-max-maxscore",
        wallMs: performance.now() - started,
        retainedPageBytes: reader.memory.pages.bytes,
        retainedDecodedBytes: reader.memory.decoded.bytes,
      },
    };
  }
}
