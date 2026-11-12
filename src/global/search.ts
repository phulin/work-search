import { completeSeeds } from "./seeds.js";
import type { PairCostTable } from "./pair-costs.js";
import { parse, queryTerms, type Node } from "../query/parser.js";
import { requiredTerms } from "../query/load.js";
import { positionalMatcher, QueryResourceError } from "../query/evaluate.js";
import {
  encodePositions,
  attachPositions,
  type DecodedPostings,
  type Posting,
  decoder,
} from "../format/codec.js";
import { PageReader } from "./storage.js";
import {
  decodeRoot,
  decodeTerm,
  decodeRows,
  TILE_DOCS,
  CHUNK_TOKENS,
  type Term,
  type Row,
  type Address,
  type Block,
} from "./format.js";
import {
  planWindows,
  PositionVerifier,
  frameExcerpt,
  type TokenFrame,
} from "./windows.js";
const refKey = (a: Address) => a.join(":");
const before = (a: Hit, b: Hit) =>
  a.score > b.score || (a.score === b.score && a.doc < b.doc);
interface Hit {
  doc: number;
  id: string;
  score: number;
  row: Row;
  span?: { start: number; end: number };
  passage: Address;
  tailPassage?: Address;
  excerpt?: string;
}
class TopK {
  values: Hit[] = [];
  constructor(readonly k: number) {}
  get threshold() {
    return this.values.length === this.k ? this.values[0] : undefined;
  }
  add(hit: Hit) {
    const a = this.values;
    if (a.length === this.k && !before(hit, a[0])) return;
    if (a.length < this.k) {
      let i = a.length;
      a.push(hit);
      while (i) {
        const p = (i - 1) >>> 1;
        if (!before(a[p], hit)) break;
        a[i] = a[p];
        i = p;
      }
      a[i] = hit;
    } else {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && before(a[c], a[c + 1])) c++;
        if (!before(hit, a[c])) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = hit;
    }
  }
}
export interface GlobalSearchOptions {
  limit?: number;
  field?: "all" | "body" | "title";
  titleBoost?: number;
  metadata?: boolean;
  snippets?: boolean;
  after?: { score: number; doc: number };
  maxPlanBytes?: number;
  maxBatchBytes?: number;
  batchTiles?: number;
  microPlans?: boolean;
  directPositions?: boolean;
  decodedCache?: boolean;
  prefetch?: boolean;
  competitivePositions?: boolean;
  /** Document-ordered, bounded positional verification for broad queries. */
  adaptivePositions?: boolean;
  /** Fused probe retains original position scanning for dense matches. */
  adaptiveProbe?: "competitive" | "fused";
  /** Complete conservative superset of matching docs, e.g. a phrase-pair index. */
  candidateFilter?: ReadonlySet<number>;
  heapAdmission?: boolean;
  decodedReads?: boolean;
  verificationBatchDocs?: number;
  tokenWindows?: boolean;
  pairCosts?: PairCostTable;
  cofetchPositions?: boolean;
  completeSeeds?: boolean;
  adaptiveRetrieval?: boolean;
}
function hasPositions(n: Node): boolean {
  return (
    n.kind === "phrase" ||
    n.kind === "near" ||
    ("left" in n && (hasPositions(n.left) || hasPositions(n.right))) ||
    ("child" in n && hasPositions(n.child))
  );
}
function hasNear(n: Node): boolean {
  return (
    n.kind === "near" ||
    ("left" in n && (hasNear(n.left) || hasNear(n.right))) ||
    ("child" in n && hasNear(n.child))
  );
}
function canMatchWithoutTerms(n: Node): boolean {
  if (n.kind === "all" || n.kind === "not") return true;
  if (n.kind === "or")
    return canMatchWithoutTerms(n.left) || canMatchWithoutTerms(n.right);
  if (n.kind === "and" || n.kind === "near")
    return canMatchWithoutTerms(n.left) && canMatchWithoutTerms(n.right);
  if (n.kind === "except") return canMatchWithoutTerms(n.left);
  return false;
}
function possible(n: Node, present: Set<string>): boolean {
  switch (n.kind) {
    case "empty":
      return false;
    case "all":
    case "not":
      return true;
    case "term":
      return present.has(n.term);
    case "phrase":
      return n.terms.every((t) => present.has(t));
    case "or":
      return possible(n.left, present) || possible(n.right, present);
    case "except":
      return possible(n.left, present);
    default:
      return possible(n.left, present) && possible(n.right, present);
  }
}
function decoded(rows: Row[], positions: boolean): DecodedPostings {
  const list: DecodedPostings = {
    docs: Uint32Array.from(rows, (r) => r.doc),
    body: Uint32Array.from(rows, (r) => r.body),
    title: Uint32Array.from(rows, (r) => r.title),
    bytes: new Uint8Array(),
    frequencyCrc: 0,
  };
  if (positions) {
    const postings: Posting[] = rows.map((r) => ({
      doc: r.doc,
      body: r.body,
      title: r.title,
      bodyPositions: r.bp ?? [],
      titlePositions: r.tp ?? [],
    }));
    attachPositions(list, encodePositions(postings, 0));
  }
  return list;
}
function coarseTree(n: Node): Node {
  if (n.kind === "phrase")
    return n.terms
      .map((term) => ({ kind: "term", term }) as Node)
      .reduce((left, right) => ({ kind: "and", left, right }));
  if (n.kind === "near")
    return {
      kind: "and",
      left: coarseTree(n.left),
      right: coarseTree(n.right),
    };
  if (n.kind === "not") return { kind: "all" };
  if (n.kind === "except") return coarseTree(n.left);
  if (n.kind === "and" || n.kind === "or")
    return { ...n, left: coarseTree(n.left), right: coarseTree(n.right) };
  return n;
}
export class GlobalIndex {
  readonly root;
  readonly hot;
  readonly bundleBytes: number;
  constructor(bytes: Uint8Array) {
    this.bundleBytes = bytes.length;
    const r = decodeRoot(bytes);
    this.root = r.root;
    this.hot = r.hot;
  }
  async terms(names: string[], reader: PageReader, maxBytes: number) {
    const result = new Map<string, Term>(),
      pages = new Map<number, string[]>();
    let planBytes = 0;
    for (const term of names) {
      const local = this.hot.lookup(term);
      if (local) {
        planBytes += local.length;
        result.set(term, decodeTerm(local));
        continue;
      }
      let lo = 0,
        hi = this.root.dictionary.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (this.root.dictionary[m].first <= term) lo = m + 1;
        else hi = m;
      }
      const id = lo - 1;
      if (id >= 0 && term <= this.root.dictionary[id].last) {
        if (!pages.has(id)) pages.set(id, []);
        pages.get(id)!.push(term);
      } else result.set(term, { df: 0, blocks: [], omitted: 0, omittedDoc: 0 });
    }
    if (planBytes > maxBytes)
      throw new QueryResourceError("Global query plan exceeds memory budget");
    const ids = [...pages.keys()],
      payloads = await reader.readMany(
        ids.map((id) => this.root.dictionary[id].address),
        "dictionary",
      );
    const { Dictionary } = await import("./format.js");
    for (let i = 0; i < ids.length; i++) {
      const d = new Dictionary(payloads[i]);
      for (const term of pages.get(ids[i])!) {
        const b = d.lookup(term);
        planBytes += b?.length ?? 0;
        if (planBytes > maxBytes)
          throw new QueryResourceError(
            "Global query plan exceeds memory budget",
          );
        result.set(
          term,
          b ? decodeTerm(b) : { df: 0, blocks: [], omitted: 0, omittedDoc: 0 },
        );
      }
    }
    return result;
  }
  async search(
    reader: PageReader,
    q: string,
    options: GlobalSearchOptions = {},
  ) {
    if (reader.root.generation !== this.root.generation)
      throw Error("Global reader generation mismatch");
    reader.clearTrace();
    const started = performance.now(),
      ast = parse(q),
      names = queryTerms(ast),
      positive = queryTerms(ast, true),
      positions = hasPositions(ast),
      limit = options.limit ?? 20,
      field = options.field ?? "all",
      boost = options.titleBoost ?? 2,
      metadata = options.metadata !== false,
      snippets = options.snippets !== false,
      maxBatch = options.maxBatchBytes ?? 4 * 1048576;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isFinite(boost) ||
      boost < 0 ||
      boost > 20
    )
      throw Error("Invalid global search options");
    if (
      options.after &&
      (!Number.isFinite(options.after.score) ||
        !Number.isInteger(options.after.doc) ||
        options.after.doc < 0 ||
        options.after.doc >= this.root.count)
    )
      throw new Error("Invalid search-after cursor");
    if (names.length > 32)
      throw new QueryResourceError(
        "Global queries support at most 32 distinct terms",
      );
    if (ast.kind === "empty")
      return {
        results: [],
        diagnostics: { milliseconds: 0, rounds: [], indexRounds: 0 },
      };
    const universe = canMatchWithoutTerms(ast),
      plans = await this.terms(
        universe ? [...names, ""] : names,
        reader,
        Math.min(
          options.maxPlanBytes ?? 12 * 1048576,
          Math.max(
            1048576,
            Math.floor((96 * 1048576 - this.bundleBytes - 32 * 1048576) / 6),
          ),
        ),
      ),
      heap = new TopK(limit),
      seen = new Set<number>();
    let scored = 0,
      tilesVisited = 0,
      skipped = 0,
      seedHits = 0,
      spanFallbacks = 0;
    const proposedWindow = options.tokenWindows
      ? planWindows(ast, plans, field)
      : undefined;
    const sparseCandidates =
      !!options.candidateFilter && options.candidateFilter.size <= 128;
    const windowPlan =
      proposedWindow &&
      (!options.adaptiveRetrieval ||
        sparseCandidates ||
        plans.get(proposedWindow.anchor)!.df <= 1024)
        ? proposedWindow
        : undefined;
    const broadPositions =
      positions &&
      Math.min(
        ...[...requiredTerms(ast)]
          .map((t) => plans.get(t)?.df ?? 0)
          .filter((n) => n > 0),
      ) > 1024;
    const adaptiveRequested =
      broadPositions && options.adaptivePositions !== false;
    let adaptive = false,
      adaptiveProbed = false;
    const adaptiveProbe = options.adaptiveProbe ?? "fused";
    let competitive =
      !!windowPlan ||
      (broadPositions &&
        (adaptiveRequested || options.competitivePositions === true) &&
        !(adaptiveRequested && adaptiveProbe === "fused"));
    let fetchPositions = positions && !competitive;
    const loadsPositions = (term: string) =>
      fetchPositions || term === windowPlan?.anchor;
    let cofetchedPositionBlocks = 0,
      cofetchedPositionRawBytes = 0;
    let windowDocuments = 0,
      windowFallbacks = 0;
    let verifiedDocuments = 0,
      positionBlocksRead = 0;
    const inline = new Map<string, Row[]>();
    for (const [term, t] of plans) {
      if (t.inline?.length) {
        const rows = decodeRows(t.inline);
        if (positions && t.inlinePositions?.length) {
          const ps = decodeRows(t.inlinePositions);
          rows.forEach((r, i) => Object.assign(r, ps[i]));
        }
        inline.set(term, rows);
      }
    }
    const decodedCache = new (
      await import("../query/runtime.js")
    ).SearchRuntime(options.decodedCache === false ? 0 : 4 * 1048576);
    let seedDocuments = 0,
      seedBlocks = 0;
    let seeding = true;
    const score = (
      byTerm: Map<string, Row[]>,
      candidates?: Set<number>,
      frames?: Map<number, TokenFrame[]>,
    ) => {
      const maps = new Map(
          [...byTerm].map(([t, rs]) => [t, new Map(rs.map((r) => [r.doc, r]))]),
        ),
        lists = new Map(
          [...byTerm]
            .filter(([t]) => t !== "")
            .map(([t, rs]) => [
              t,
              decoded(rs, positions && options.directPositions === false),
            ]),
        ),
        match = positionalMatcher(
          ast,
          lists,
          field,
          positions && options.directPositions !== false
            ? (term, doc, f) => {
                const r = maps.get(term)?.get(doc);
                return f === 0 ? r?.bp : r?.tp;
              }
            : undefined,
        ),
        docs = candidates
          ? [...candidates].sort((a, b) => a - b)
          : [
              ...new Set(
                [...byTerm.values()].flatMap((rs) => rs.map((r) => r.doc)),
              ),
            ].sort((a, b) => a - b);
      for (const doc of docs) {
        if (
          (options.candidateFilter && !options.candidateFilter.has(doc)) ||
          seen.has(doc) ||
          !match(doc)
        )
          continue;
        let value = 0;
        for (const term of positive) {
          const r = maps.get(term)?.get(doc);
          if (r)
            value +=
              (field !== "title" ? r.b : 0) +
              (field !== "body" ? boost * r.t : 0);
        }
        if (
          options.after &&
          (value > options.after.score ||
            (value === options.after.score && doc <= options.after.doc))
        )
          continue;
        scored++;
        if (seeding) seen.add(doc);
        const threshold = heap.threshold;
        if (
          options.heapAdmission !== false &&
          threshold &&
          (value < threshold.score ||
            (value === threshold.score && doc >= threshold.doc))
        )
          continue;
        let row: Row | undefined;
        for (const term of positive) {
          const r = maps.get(term)?.get(doc);
          if (r?.body) {
            row = r;
            break;
          }
        }
        row ??= [...maps.values()].map((m) => m.get(doc)).find(Boolean);
        if (!row) throw Error("Missing global result pointer");
        let span: { start: number; end: number } | undefined;
        if (positions && (!heap.threshold || value >= heap.threshold.score)) {
          try {
            span =
              frames?.has(doc) && windowPlan
                ? positionalMatcher(windowPlan.node, lists, field, (t, d, f) =>
                    f === 0 ? maps.get(t)?.get(d)?.bp : maps.get(t)?.get(d)?.tp,
                  ).firstBodySpan(doc)
                : match.firstBodySpan(doc);
          } catch (e) {
            if (!(e instanceof QueryResourceError)) throw e;
            spanFallbacks++;
          }
        }
        if (!span && row.body) span = { start: row.first, end: row.first };
        let passage = row.passage;
        if (span) {
          const chunk = Math.floor(span.start / CHUNK_TOKENS);
          for (const m of maps.values()) {
            const r = m.get(doc),
              found = r?.chunks?.find(([id]) => id === chunk);
            if (found) {
              passage = found[1];
              break;
            }
          }
        }
        let tailPassage: Address | undefined;
        if (
          span &&
          Math.floor(span.end / CHUNK_TOKENS) !==
            Math.floor(span.start / CHUNK_TOKENS)
        ) {
          const endChunk = Math.floor(span.end / CHUNK_TOKENS);
          for (const m of maps.values()) {
            const found = m.get(doc)?.chunks?.find(([id]) => id === endChunk);
            if (found) {
              tailPassage = found[1];
              break;
            }
          }
        }
        // Heap entries retain display pointers, never complete positional arrays.
        const { bp, tp, chunks, ...displayRow } = row;
        heap.add({
          doc,
          id: row.id,
          score: value,
          row: displayRow,
          span,
          passage,
          tailPassage,
          excerpt:
            frames
              ?.get(doc)
              ?.find(
                (p) =>
                  span &&
                  span.start >= p.first &&
                  span.end < p.first + p.starts.length,
              ) && span
              ? frameExcerpt(
                  frames
                    .get(doc)!
                    .find(
                      (p) =>
                        span!.start >= p.first &&
                        span!.end < p.first + p.starts.length,
                    )!,
                  span,
                )
              : undefined,
        });
      }
    };
    // Seed rows are complete for single terms. Multi-term seeds are only admitted
    // when every queried term is represented, so scores and Boolean truth are exact.
    const seeds = new Map<string, Row[]>();
    if (!positions && !universe) {
      for (const term of names) {
        const t = plans.get(term)!;
        seeds.set(
          term,
          inline.get(term) ?? (t.seeds?.length ? decodeRows(t.seeds) : []),
        );
      }
      const common = new Set(seeds.get(names[0])?.map((r) => r.doc) ?? []);
      for (const rs of seeds.values()) {
        const docs = new Set(rs.map((r) => r.doc));
        for (const doc of common) if (!docs.has(doc)) common.delete(doc);
      }
      score(seeds, common);
      seedHits = heap.values.length;
    }
    if (options.completeSeeds && !positions && !universe && names.length > 1) {
      const completed = await completeSeeds(
        plans,
        seeds,
        positive,
        reader,
        decodedCache,
        { field, boost, maxRaw: maxBatch, seen, after: options.after },
      );
      seedDocuments = completed.docs.size;
      seedBlocks = completed.blocks;
      score(completed.rows, completed.docs);
      seedHits = heap.values.length;
    }
    const seedThreshold = heap.threshold?.score;
    seeding = false;
    let seedProof = false;
    if (
      ast.kind === "term" &&
      field === "all" &&
      boost === 2 &&
      !options.after
    ) {
      const t = plans.get(ast.term)!,
        threshold = heap.threshold;
      seedProof =
        !!threshold &&
        (t.omitted < threshold.score ||
          (t.omitted === threshold.score && t.omittedDoc > threshold.doc));
    }

    const positionCache = new (
      await import("../query/runtime.js")
    ).SearchRuntime(4 * 1048576);
    const verifyBatch = async (
      byTerm: Map<string, Row[]>,
      candidates?: Set<number>,
    ) => {
      const maps = new Map(
        [...byTerm].map(([t, rows]) => [
          t,
          new Map(rows.map((r) => [r.doc, r])),
        ]),
      );
      const lists = new Map(
        [...byTerm]
          .filter(([t]) => t !== "")
          .map(([t, rows]) => [t, decoded(rows, false)]),
      );
      const coarse = positionalMatcher(coarseTree(ast), lists, field);
      const docs = candidates
        ? [...candidates]
        : [
            ...new Set(
              [...byTerm.values()].flatMap((rs) => rs.map((r) => r.doc)),
            ),
          ];
      const ranked: { doc: number; score: number }[] = [];
      for (const doc of docs) {
        if (
          (options.candidateFilter && !options.candidateFilter.has(doc)) ||
          !coarse(doc)
        )
          continue;
        let value = 0;
        for (const term of positive) {
          const r = maps.get(term)?.get(doc);
          if (r)
            value +=
              (field !== "title" ? r.b : 0) +
              (field !== "body" ? boost * r.t : 0);
        }
        if (
          options.after &&
          (value > options.after.score ||
            (value === options.after.score && doc <= options.after.doc))
        )
          continue;
        ranked.push({ doc, score: value });
      }
      ranked.sort(
        adaptive
          ? (a, b) => a.doc - b.doc
          : (a, b) => b.score - a.score || a.doc - b.doc,
      );
      if (windowPlan) {
        let cursor = 0;
        const verifier = new PositionVerifier(
          reader,
          plans,
          positionCache,
          windowPlan,
          field,
        );
        while (cursor < ranked.length) {
          const threshold = heap.threshold,
            candidate = ranked[cursor];
          if (
            threshold &&
            (candidate.score < threshold.score ||
              (candidate.score === threshold.score &&
                candidate.doc > threshold.doc))
          ) {
            if (!adaptive) break;
            cursor++;
            continue;
          }
          const batch = await verifier.batch(
            byTerm,
            ranked.slice(cursor).map((c) => c.doc),
            options.verificationBatchDocs ?? (adaptive ? 4096 : 32),
            maxBatch,
          );
          cursor += batch.docs.length;
          verifiedDocuments += batch.docs.length;
          positionBlocksRead += batch.positionBlocks;
          windowDocuments += batch.windowDocs;
          windowFallbacks += batch.windowFallbacks;
          score(batch.rows, new Set(batch.docs), batch.windows);
        }
        return;
      }
      const blockFor = (term: string, doc: number) => {
        const blocks = plans.get(term)!.blocks;
        let lo = 0,
          hi = blocks.length;
        while (lo < hi) {
          const m = (lo + hi) >>> 1;
          if (blocks[m].last < doc) lo = m + 1;
          else hi = m;
        }
        const b = blocks[lo];
        if (!b || b.first > doc) throw Error("Missing verification block");
        return b;
      };
      let cursor = 0;
      while (cursor < ranked.length) {
        const threshold = heap.threshold,
          candidate = ranked[cursor];
        if (
          threshold &&
          (candidate.score < threshold.score ||
            (candidate.score === threshold.score &&
              candidate.doc > threshold.doc))
        ) {
          if (!adaptive) break;
          cursor++;
          continue;
        }
        const selected: number[] = [],
          needed = new Map<
            string,
            { ref: Address; term: string; docs: Set<number> }
          >();
        let raw = 0;
        const pages = new Set<string>();
        while (
          cursor < ranked.length &&
          selected.length <
            (options.verificationBatchDocs ?? (adaptive ? 4096 : 32))
        ) {
          const candidate = ranked[cursor],
            refs: { term: string; ref: Address }[] = [];
          for (const term of names) {
            const r = maps.get(term)?.get(candidate.doc);
            if (r && !r.bp)
              refs.push({ term, ref: blockFor(term, candidate.doc).positions });
          }
          let extra = 0;
          const nextPages = new Set(pages);
          for (const { ref } of refs) {
            const key = refKey(ref);
            if (!needed.has(key) && !positionCache.peek(key)) extra += ref[4];
            for (
              let p = Math.floor(ref[1] / reader.root.pageBytes);
              p <= Math.floor((ref[1] + ref[2] - 1) / reader.root.pageBytes);
              p++
            )
              nextPages.add(ref[0] + ":" + p);
          }
          if (
            selected.length &&
            (raw + extra > maxBatch ||
              nextPages.size * reader.root.pageBytes > 16 * 1048576)
          )
            break;
          if (raw + extra > maxBatch)
            throw new QueryResourceError(
              "One positional candidate exceeds memory budget",
            );
          raw += extra;
          for (const p of nextPages) pages.add(p);
          for (const { term, ref } of refs) {
            const key = refKey(ref);
            if (!needed.has(key))
              needed.set(key, { ref, term, docs: new Set() });
            needed.get(key)!.docs.add(candidate.doc);
          }
          selected.push(candidate.doc);
          cursor++;
        }
        const buffers = new Map<string, Uint8Array>();
        for (const key of needed.keys()) {
          const cached = positionCache.get<Uint8Array>(key);
          if (cached) buffers.set(key, cached);
        }
        const missing = [...needed].filter(([key]) => !buffers.has(key)),
          payloads = await reader.readMany(
            missing.map(([, n]) => n.ref),
            "candidate-positions",
          );
        positionBlocksRead += missing.length;
        missing.forEach(([key], i) => {
          buffers.set(key, payloads[i]);
          positionCache.set(key, payloads[i], payloads[i].length);
        });
        const decodedPositions = new Map<string, Map<number, Row>>();
        for (const [key, n] of needed) {
          const data = buffers.get(key)!;
          const rows = decodeRows(data, n.docs);
          if (!decodedPositions.has(n.term))
            decodedPositions.set(n.term, new Map());
          for (const row of rows)
            decodedPositions.get(n.term)!.set(row.doc, row);
        }
        const selectedSet = new Set(selected),
          verification = new Map<string, Row[]>();
        for (const [term, rows] of byTerm) {
          const list: Row[] = [];
          for (const row of rows) {
            if (!selectedSet.has(row.doc)) continue;
            const p = row.bp ? row : decodedPositions.get(term)?.get(row.doc);
            if (
              term !== "" &&
              (!p || p.bp!.length !== row.body || p.tp!.length !== row.title)
            )
              throw Error("Frequency/position verification mismatch");
            list.push(term === "" ? row : { ...row, ...p });
          }
          verification.set(term, list);
        }
        verifiedDocuments += selected.length;
        score(verification, selectedSet);
      }
    };
    const required = [...requiredTerms(ast)].filter((t) => plans.get(t)?.df),
      lead = required.sort((a, b) => plans.get(a)!.df - plans.get(b)!.df)[0];
    let leadRows: Row[] | undefined;
    const leadCost = lead
      ? plans
          .get(lead)!
          .blocks.reduce(
            (n, b) =>
              n + b.frequency[4] + (loadsPositions(lead) ? b.positions[4] : 0),
            0,
          )
      : 0;
    if (
      !seedProof &&
      lead &&
      plans.get(lead)!.df <= 1024 &&
      leadCost <= maxBatch
    ) {
      leadRows = inline.get(lead);
      if (!leadRows) {
        const t = plans.get(lead)!,
          refs = t.blocks.flatMap((b) =>
            loadsPositions(lead) ? [b.frequency, b.positions] : [b.frequency],
          ),
          bytes = await reader.readMany(refs, "rare-lead");
        leadRows = [];
        for (let i = 0; i < t.blocks.length; i++) {
          const rs = decodeRows(bytes[i * (loadsPositions(lead) ? 2 : 1)]);
          if (loadsPositions(lead)) {
            const ps = decodeRows(bytes[i * 2 + 1]);
            rs.forEach((r, j) => Object.assign(r, ps[j]));
          }
          leadRows.push(...rs);
        }
      }
    }
    const leadDocs = leadRows ? new Set(leadRows.map((r) => r.doc)) : undefined;
    const micro =
      options.microPlans !== false &&
      field === "all" &&
      boost === 2 &&
      [...plans.values()].every((t) => !t.df || !!t.windows);
    const selectedWindowDocs = micro
      ? Math.max(
          8,
          ...[...plans.values()]
            .filter((t) => t.df)
            .map((t) => t.windowDocs ?? 64),
        )
      : TILE_DOCS;
    // Low-prevalence proximity already has a selective anchor. Coarsen to avoid
    // multiplying planning/probe overhead; broad proximity retains fine bounds.
    const windowDocs =
      options.adaptiveRetrieval &&
      micro &&
      hasNear(ast) &&
      Math.min(...[...requiredTerms(ast)].map((t) => plans.get(t)?.df ?? 0)) <=
        this.root.count / 8
        ? Math.max(64, selectedWindowDocs)
        : selectedWindowDocs;
    const windows = new Map<
      number,
      {
        tile: number;
        bound: number;
        present: Set<string>;
        blocks: Map<string, Block[]>;
        upper?: Map<string, number>;
      }
    >();
    const relevant = (blocks: Block[]) => {
      if (!leadRows) return blocks;
      const ids = new Set<number>();
      for (const row of leadRows) {
        let lo = 0,
          hi = blocks.length;
        while (lo < hi) {
          const m = (lo + hi) >>> 1;
          if (blocks[m].last < row.doc) lo = m + 1;
          else hi = m;
        }
        if (lo < blocks.length && blocks[lo].first <= row.doc) ids.add(lo);
      }
      return [...ids].sort((a, b) => a - b).map((i) => blocks[i]);
    };
    if (!seedProof && micro) {
      const relevantCell = (first: number, last: number) => {
        if (!leadRows) return true;
        let lo = 0,
          hi = leadRows.length;
        while (lo < hi) {
          const m = (lo + hi) >>> 1;
          if (leadRows[m].doc < first) lo = m + 1;
          else hi = m;
        }
        return lo < leadRows.length && leadRows[lo].doc <= last;
      };
      for (const [term, t] of plans) {
        let at = 0;
        for (const [originalCell, upper] of t.windows ?? []) {
          const cell = Math.floor(
            (originalCell * (t.windowDocs ?? 64)) / windowDocs,
          );
          const first = cell * windowDocs,
            last = first + windowDocs - 1;
          if (!relevantCell(first, last)) continue;
          while (at < t.blocks.length && t.blocks[at].last < first) at++;
          const bs: Block[] = [];
          for (
            let i = at;
            i < t.blocks.length && t.blocks[i].first <= last;
            i++
          )
            bs.push(t.blocks[i]);
          let w = windows.get(cell);
          if (!w) {
            w = {
              tile: cell,
              bound: 0,
              present: new Set(),
              blocks: new Map(),
              upper: new Map(),
            };
            windows.set(cell, w);
          }
          w.present.add(term);
          w.blocks.set(term, bs);
          w.upper!.set(term, Math.max(upper, w.upper!.get(term) ?? 0));
        }
      }
    } else {
      if (!seedProof)
        for (const [term, t] of plans)
          for (const b of relevant(t.blocks)) {
            let w = windows.get(b.tile);
            if (!w) {
              w = {
                tile: b.tile,
                bound: 0,
                present: new Set(),
                blocks: new Map(),
              };
              windows.set(b.tile, w);
            }
            w.present.add(term);
            if (!w.blocks.has(term)) w.blocks.set(term, []);
            w.blocks.get(term)!.push(b);
          }
    }
    const candidateCells =
      options.candidateFilter &&
      new Set(
        [...options.candidateFilter].map((doc) => Math.floor(doc / windowDocs)),
      );
    const queue = [...windows.values()].filter(
      (w) =>
        (!candidateCells || candidateCells.has(w.tile)) &&
        possible(ast, w.present),
    );
    for (const w of queue) {
      for (const term of positive) {
        const bs = w.blocks.get(term) ?? [];
        if (micro) {
          w.bound += w.upper!.get(term) ?? 0;
          continue;
        }
        w.bound +=
          (field !== "title" ? Math.max(0, ...bs.map((b) => b.b)) : 0) +
          (field !== "body" ? boost * Math.max(0, ...bs.map((b) => b.t)) : 0);
      }
      // Bounds and row contributions are float64, summed in the same positive-term
      // order. Nonnegative IEEE arithmetic is monotone; no quantization is used.
    }
    // Equal bounds must be ordered by minimum doc ID: the stopping proof below
    // relies on all remaining equal-bound windows having no earlier IDs.
    queue.sort(
      adaptive
        ? (a, b) => a.tile - b.tile
        : (a, b) => b.bound - a.bound || a.tile - b.tile,
    );

    let prefetch: Promise<unknown> | undefined;
    let prefetchedDocs = new Set<number>();
    let prefetchFailures = 0;
    let cursor = 0;
    while (cursor < queue.length) {
      const threshold = heap.threshold;
      if (
        threshold &&
        (queue[cursor].bound < threshold.score ||
          (queue[cursor].bound === threshold.score &&
            queue[cursor].tile * windowDocs > threshold.doc))
      ) {
        if (!adaptive) {
          skipped += queue.length - cursor;
          break;
        }
        skipped++;
        cursor++;
        continue;
      }
      const batch: typeof queue = [];
      let rawBytes = 0;
      const pageSet = new Set<string>();
      const rawSet = new Set<string>();
      while (
        cursor < queue.length &&
        batch.length <
          (options.batchTiles ??
            (adaptive
              ? 256 * (micro ? 64 / windowDocs : 1)
              : heap.threshold
                ? 32 * (micro ? 64 / windowDocs : 1)
                : 32))
      ) {
        const w = queue[cursor];
        let cost = 0;
        const additions = new Set<string>();
        for (const [term, bs] of w.blocks) {
          if (inline.has(term) || (term === lead && leadRows)) continue;
          for (const b of bs.filter(
            (b) =>
              options.decodedReads === false ||
              !decodedCache.peek(refKey(b.frequency)),
          ))
            for (const ref of loadsPositions(term)
              ? [b.frequency, b.positions]
              : [b.frequency]) {
              const key = refKey(ref);
              if (!rawSet.has(key) && !additions.has(key)) {
                cost += ref[4];
                additions.add(key);
              }
            }
        }
        const nextPages = new Set(pageSet);
        for (const [term, bs] of w.blocks) {
          if (inline.has(term) || (term === lead && leadRows)) continue;
          for (const b of bs.filter(
            (b) =>
              options.decodedReads === false ||
              !decodedCache.peek(refKey(b.frequency)),
          ))
            for (const ref of loadsPositions(term)
              ? [b.frequency, b.positions]
              : [b.frequency]) {
              for (
                let p = Math.floor(ref[1] / reader.root.pageBytes);
                p <= Math.floor((ref[1] + ref[2] - 1) / reader.root.pageBytes);
                p++
              )
                nextPages.add(ref[0] + ":" + p);
            }
        }
        if (
          batch.length &&
          (rawBytes + cost > maxBatch ||
            nextPages.size * reader.root.pageBytes > 16 * 1048576)
        )
          break;
        for (const p of nextPages) pageSet.add(p);
        if (cost > maxBatch)
          throw new QueryResourceError("One global tile exceeds memory budget");
        for (const key of additions) rawSet.add(key);
        rawBytes += cost;
        batch.push(w);
        cursor++;
      }
      const refs: Address[] = [],
        slots = new Map<string, number>(),
        batchDecoded = new Map<string, Row[]>();
      if (options.decodedReads !== false) {
        for (const w of batch)
          for (const bs of w.blocks.values())
            for (const b of bs) {
              const key = refKey(b.frequency),
                cached = decodedCache.get<Row[]>(key);
              if (cached) batchDecoded.set(key, cached);
            }
      }
      for (const w of batch)
        for (const [term, bs] of w.blocks) {
          if (inline.has(term) || (term === lead && leadRows)) continue;
          for (const b of bs.filter(
            (b) => !batchDecoded.has(refKey(b.frequency)),
          ))
            for (const ref of loadsPositions(term)
              ? [b.frequency, b.positions]
              : [b.frequency]) {
              const key = refKey(ref);
              if (!slots.has(key)) {
                slots.set(key, refs.length);
                refs.push(ref);
              }
            }
        }
      // Preserve position frames already covered by this batch's physical reads.
      // This consumes spare expanded-byte budget, never another R2 page.
      if (
        positions &&
        options.cofetchPositions &&
        (!options.adaptiveRetrieval || sparseCandidates)
      ) {
        const pages = new Set<string>();
        const pagesOf = (r: Address) =>
          Array.from(
            {
              length:
                Math.floor((r[1] + r[2] - 1) / reader.root.pageBytes) -
                Math.floor(r[1] / reader.root.pageBytes) +
                1,
            },
            (_, i) =>
              r[0] + ":" + (Math.floor(r[1] / reader.root.pageBytes) + i),
          );
        for (const ref of refs) for (const p of pagesOf(ref)) pages.add(p);
        let expanded = refs.reduce((n, r) => n + r[4], 0);
        for (const w of batch)
          for (const [term, bs] of w.blocks) {
            if (inline.has(term) || (term === lead && leadRows)) continue;
            for (const b of bs) {
              const id = refKey(b.positions);
              if (
                !slots.has(id) &&
                !batchDecoded.has(refKey(b.frequency)) &&
                expanded + b.positions[4] <= maxBatch &&
                pagesOf(b.positions).every((p) => pages.has(p))
              ) {
                slots.set(id, refs.length);
                refs.push(b.positions);
                cofetchedPositionBlocks++;
                cofetchedPositionRawBytes += b.positions[4];
                expanded += b.positions[4];
              }
            }
          }
      }
      const payloads = await reader.readMany(refs, "index-blocks");
      const frequencyBatch = new Map<string, Row[]>();
      for (const w of batch) {
        tilesVisited++;
        const rows = new Map<string, Row[]>();
        for (const [term, bs] of w.blocks) {
          const local =
            inline.get(term) ?? (term === lead ? leadRows : undefined);
          if (local) {
            rows.set(
              term,
              local.filter((r) => Math.floor(r.doc / windowDocs) === w.tile),
            );
            continue;
          }
          const merged: Row[] = [];
          for (const b of bs) {
            const blockKey = refKey(b.frequency);
            let rs =
              batchDecoded.get(blockKey) ?? decodedCache.get<Row[]>(blockKey);
            if (!rs) {
              rs = decodeRows(payloads[slots.get(refKey(b.frequency))!]);
              if (slots.has(refKey(b.positions))) {
                const ps = decodeRows(
                  payloads[slots.get(refKey(b.positions))!],
                );
                if (ps.length !== rs.length)
                  throw Error("Global positional row mismatch");
                rs.forEach((r, i) => {
                  if (r.doc !== ps[i].doc)
                    throw Error("Global positional document mismatch");
                  Object.assign(r, ps[i]);
                });
              }
              if (options.decodedReads !== false)
                batchDecoded.set(blockKey, rs);
              decodedCache.set(
                blockKey,
                rs,
                b.frequency[4] * 6 +
                  (rs[0]?.bp ? b.positions[4] * 8 : 0) +
                  rs.length * 256,
              );
            }
            merged.push(
              ...rs.filter((r) => Math.floor(r.doc / windowDocs) === w.tile),
            );
          }
          rows.set(term, merged);
        }
        if (competitive) {
          for (const [term, list] of rows) {
            if (!frequencyBatch.has(term)) frequencyBatch.set(term, []);
            frequencyBatch.get(term)!.push(...list);
          }
        } else {
          score(
            rows,
            leadDocs
              ? new Set(
                  [...leadDocs].filter(
                    (doc) => Math.floor(doc / windowDocs) === w.tile,
                  ),
                )
              : undefined,
          );
        }
      }
      if (competitive) {
        for (const rows of frequencyBatch.values())
          rows.sort((a, b) => a.doc - b.doc);
        await verifyBatch(
          frequencyBatch,
          leadDocs
            ? new Set(
                [...leadDocs].filter((doc) =>
                  batch.some((w) => Math.floor(doc / windowDocs) === w.tile),
                ),
              )
            : undefined,
        );
      }
      // A small score-ordered probe finds dense phrases quickly. If it does not
      // fill top-K, traverse the remaining cells in document order to
      // keep adjacent positional blocks in the same bounded verification batch.
      if (adaptiveRequested && !adaptiveProbed) {
        adaptiveProbed = true;
        if (!heap.threshold) {
          adaptive = true;
          if (!competitive) {
            // Fused cache entries own positions; drop them before retaining
            // frequency-only rows under the same block keys.
            decodedCache.clear();
            competitive = true;
            fetchPositions = false;
          }
          const remaining = queue.splice(cursor);
          remaining.sort((a, b) => a.tile - b.tile);
          queue.push(...remaining);
        }
      }
      if (
        options.prefetch &&
        !prefetch &&
        heap.values.length >= Math.min(limit, 20)
      ) {
        const hints = heap.values.slice(0, 20);
        prefetchedDocs = new Set(hints.map((h) => h.doc));
        const refs: Address[] = [];
        const keys = new Set<string>();
        for (const h of hints)
          for (const ref of [
            ...(metadata && !h.row.recordData ? [h.row.record] : []),
            ...(snippets && !h.excerpt && !(h.row.excerpt && !positions)
              ? [h.passage, ...(h.tailPassage ? [h.tailPassage] : [])]
              : []),
          ]) {
            const key = refKey(ref);
            if (!keys.has(key)) {
              keys.add(key);
              refs.push(ref);
            }
          }
        if (refs.length)
          prefetch = reader.readMany(refs, "prefetch-results").catch(() => {
            prefetchFailures++;
          });
      }
    }
    const hits = heap.values.sort((a, b) => b.score - a.score || a.doc - b.doc),
      refs: Address[] = [],
      slots = new Map<string, number>();
    for (const h of hits) {
      for (const p of [
        ...(metadata && !h.row.recordData ? [h.row.record] : []),
        ...(snippets && !h.excerpt && !(h.row.excerpt && !positions)
          ? [h.passage, ...(h.tailPassage ? [h.tailPassage] : [])]
          : []),
      ]) {
        const key = refKey(p);
        if (!slots.has(key)) {
          slots.set(key, refs.length);
          refs.push(p);
        }
      }
    }
    if (prefetch) await prefetch;
    const payloads = await reader.readMany(refs, "results-and-passages"),
      results = hits.map((h) => {
        const result: any = { id: h.id, score: h.score, doc: h.doc };
        if (metadata) {
          const r = JSON.parse(
            h.row.recordData ??
              decoder.decode(payloads[slots.get(refKey(h.row.record))!]),
          );
          if (r.id !== h.id) throw Error("Global result identity mismatch");
          result.title = r.title;
          result.metadata = r.metadata;
        }
        if (snippets && h.excerpt) result.excerpt = h.excerpt;
        else if (snippets && h.row.excerpt && !positions)
          result.excerpt = h.row.excerpt;
        else if (snippets) {
          const p = JSON.parse(
            decoder.decode(payloads[slots.get(refKey(h.passage))!]),
          );
          let start = 0,
            end = Math.min(400, p.text.length);
          if (h.span) {
            const i = h.span.start - p.first;
            if (i >= 0 && i < p.starts.length) {
              start = Math.max(0, p.starts[i] - 160);
              end = Math.min(
                p.text.length,
                (p.ends[Math.min(p.ends.length - 1, h.span.end - p.first)] ??
                  p.ends[i]) + 240,
              );
            }
          }
          result.excerpt =
            (p.first || start ? "…" : "") +
            p.text.slice(start, end).trim() +
            (end < p.text.length ? "…" : "");
          if (
            h.tailPassage &&
            h.span &&
            h.span.end >= p.first + p.ends.length
          ) {
            const tail = JSON.parse(
                decoder.decode(payloads[slots.get(refKey(h.tailPassage))!]),
              ),
              j = h.span.end - tail.first;
            result.excerpt +=
              " … " +
              tail.text
                .slice(
                  Math.max(0, (tail.starts[j] ?? 0) - 80),
                  Math.min(tail.text.length, (tail.ends[j] ?? 0) + 240),
                )
                .trim();
          }
        }
        return result;
      });
    return {
      results,
      diagnostics: {
        milliseconds: performance.now() - started,
        rounds: reader.rounds,
        indexRounds: reader.rounds.filter(
          (r) => r.stage !== "results-and-passages" && r.requests > 0,
        ).length,
        storageRounds: reader.rounds.filter((r) => r.requests > 0).length,
        requests: reader.rounds.reduce((s, r) => s + r.requests, 0),
        bytes: reader.rounds.reduce((s, r) => s + r.bytes, 0),
        tilesVisited,
        windowDocs,
        skipped,
        scored,
        seedHits,
        seedDocuments,
        seedBlocks,
        seedThreshold,
        cofetchedPositionBlocks,
        cofetchedPositionRawBytes,
        seedProof,
        spanFallbacks,
        competitivePositions: competitive,
        adaptivePositions: adaptiveRequested,
        adaptiveProbe,
        positionalOrder: adaptive ? "document" : "score",
        adaptiveRetrieval: !!options.adaptiveRetrieval,
        tokenWindowAnchor: windowPlan?.anchor,
        windowDocuments,
        windowFallbacks,
        verifiedDocuments,
        positionBlocksRead,
        prefetchedDocs: prefetchedDocs.size,
        usefulPrefetchedDocs: hits.filter((h) => prefetchedDocs.has(h.doc))
          .length,
        prefetchFailures,
      },
    };
  }
}
