import {
  blockEligible,
  pureConjunction,
  pureDisjunction,
  searchBlocks,
} from "./block-search.js";
import { candidatePlan } from "./planning.js";
import { lowerBound } from "./sets.js";
import { SearchRuntime, postingSize, postingKey } from "./runtime.js";
import { scoreBounds, SCORE_BLOCK } from "./pruning.js";
import {
  type Read,
  loadPosting,
  requiredTerms,
  attachCandidatePositions,
} from "./load.js";
import { BinaryIndex, LOCAL } from "../format/index.js";
import { decoder } from "../format/codec.js";
import {
  parse,
  queryTerms,
  positional,
  simplify,
  needsUniverse,
  positionalTerms,
} from "./parser.js";
import { candidateDocuments, positionalMatcher } from "./evaluate.js";
export { intersect, union } from "./sets.js";
import { parallel, type Storage } from "../storage/types.js";
export function bm25(
  tf: number,
  df: number,
  n: number,
  len: number,
  avg: number,
  k1 = 1.2,
  b = 0.75,
) {
  return tf
    ? (Math.log(1 + (n - df + 0.5) / (df + 0.5)) * (tf * (k1 + 1))) /
        (tf + k1 * (1 - b + (b * len) / (avg || 1)))
    : 0;
}
interface Hit {
  id: string;
  score: number;
  doc: number;
  metadata?: unknown;
  title?: string;
}
const better = (a: Hit, b: Hit) =>
  a.score > b.score || (a.score === b.score && a.doc < b.doc);
class TopK {
  heap: Hit[] = [];
  constructor(readonly k: number) {}
  add(doc: number, score: number) {
    const a = this.heap;
    if (
      a.length === this.k &&
      (score < a[0].score || (score === a[0].score && doc >= a[0].doc))
    )
      return;
    const h: Hit = { id: "", score, doc };
    if (a.length < this.k) {
      a.push(h);
      let i = a.length - 1;
      while (i) {
        const p = (i - 1) >>> 1;
        if (!better(a[p], a[i])) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    } else if (better(h, a[0])) {
      a[0] = h;
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && better(a[c], a[c + 1])) c++;
        if (!better(a[i], a[c])) break;
        [a[i], a[c]] = [a[c], a[i]];
        i = c;
      }
    }
  }
}
export interface SearchOptions {
  r2LatencyMs?: number;
  r2BandwidthMiB?: number;
  competitivePositions?: boolean;
  pagedOptimizationStep?: number;
  pagedReadPolicy?: "fixed" | "adaptive";
  mode?: "and" | "or";
  limit?: number;
  titleBoost?: number;
  field?: "all" | "title" | "body";
  metadata?: boolean;
  exactTotal?: boolean;
  planning?: "legacy" | "adaptive";
  runtime?: SearchRuntime;
  blockCache?: boolean;
  /** Internal cumulative benchmark switch; HTTP does not expose this. */
  optimizationStage?: number;
  /** Internal benchmark override; never exposed by HTTP. */
  executor?: "auto" | "materialized" | "boolean" | "wand";
}
async function executeSearch(
  index: BinaryIndex,
  storage: Storage,
  q: string,
  options: SearchOptions = {},
  skipBlocks = true,
) {
  const stage = options.optimizationStage ?? 7;
  const exactTotal = options.exactTotal === true;
  const start = performance.now(),
    original = parse(q, options.mode ?? "and");
  await index.prepareTerms(queryTerms(original), storage, options.runtime);
  const ast = simplify(original, (t) => !!index.lookup(t)),
    terms = queryTerms(ast),
    positiveTerms = new Set(queryTerms(ast, true)),
    needsPositions = positional(ast),
    positionTerms = positionalTerms(ast),
    limit = options.limit ?? 20,
    boost = options.titleBoost ?? 2;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isFinite(boost) ||
    boost < 0 ||
    boost > 20
  )
    throw new Error("Invalid search options");
  const found = terms.map((t) => index.lookup(t));
  const lookupMs = performance.now() - start;
  const diagnostics = {
    lookupMs,
    fetchMs: 0,
    scoreMs: 0,
    indexRequests: 0,
    indexBytes: 0,
    frequencyRequests: 0,
    frequencyBytes: 0,
    positionRequests: 0,
    positionBytes: 0,
    metadataRequests: 0,
    metadataBytes: 0,
    fullyLocal: true,
    postingCacheHits: 0,
    postingCacheMisses: 0,
    cacheBytes: 0,
    boundsMs: 0,
    boundsCacheHits: 0,
    scoredDocuments: 0,
    prunedCandidates: 0,
    deferredPositions: false,
    skippedBlocks: 0,
    executor: "materialized",
    visitedDocuments: 0,
    cursorSeeks: 0,
    cursorLoads: 0,
    blocksDecoded: 0,
    blockCacheHits: 0,
    fullPostingCacheHits: 0,
    wandPivots: 0,
    wandSkips: 0,
  };
  if (ast.kind === "empty")
    return {
      results: [],
      ...(!exactTotal ? {} : { total: 0 }),
      diagnostics,
    };
  const entries = found.filter((x) => x !== undefined),
    fetchStart = performance.now();
  const cachedRows = entries.reduce(
    (sum, e) =>
      sum +
      (options.runtime?.peek(postingKey(index.generation, e)) ||
      options.runtime?.peek(postingKey(index.generation, e, true))
        ? e.df
        : 0),
    0,
  );
  const totalRows = entries.reduce((sum, e) => sum + e.df, 0);
  const wantWand =
    options.executor === "wand" ||
    (options.executor !== "boolean" &&
      options.executor !== "materialized" &&
      pureDisjunction(ast) &&
      entries.length >= 2 &&
      totalRows >= 4096 &&
      limit <= 20 &&
      options.field !== "title" &&
      Math.max(...entries.map((e) => e.df)) >=
        2 * Math.min(...entries.map((e) => e.df)) &&
      cachedRows < totalRows / 2);
  const useBlocks =
    wantWand ||
    options.executor === "boolean" ||
    (options.executor !== "materialized" &&
      !(cachedRows > totalRows / 2 && totalRows * 12 <= 8 * 1048576) &&
      (pureConjunction(ast) || (index.count > 50000 && totalRows > 100000)));
  const streaming =
    useBlocks &&
    stage >= 4 &&
    skipBlocks &&
    index.format >= 6 &&
    !exactTotal &&
    !options.metadata &&
    blockEligible(ast) &&
    entries.some((e) => e.df > 256);
  const workingBytes =
    (streaming
      ? entries.reduce(
          (sum, e) =>
            sum +
            (e.object === LOCAL
              ? 65536
              : index.paged
                ? Math.min(
                    e.length,
                    index.pagedReadPolicy === "adaptive" ? 1048576 : 65536,
                  )
                : e.length) +
            Math.ceil(e.df / 256) * 180 +
            4096,
          0,
        ) +
        q.length * 1024 +
        (wantWand ? 8 * (1 << entries.length) : 0)
      : entries.reduce(
          (s, e) =>
            s +
            (e.object === LOCAL ? 0 : e.length) +
            e.df * (exactTotal ? 20 : 16) +
            (positionTerms.has(e.term)
              ? (e.positionObject === LOCAL ? 0 : e.positionLength) +
                e.df * 4 +
                (index.format >= 7 ? Math.ceil(e.df / 256) * 4 : 0)
              : 0),
          0,
        ) + (needsUniverse(ast) ? index.count * 8 : 0)) +
    (options.competitivePositions && needsPositions && !exactTotal
      ? index.count * 32
      : 0);
  if (
    workingBytes >
    Math.min(56 * 1024 * 1024, 104 * 1024 * 1024 - index.bytes.length)
  )
    throw new Error("Query working set exceeds memory budget");
  // All phases share one four-read semaphore, including parallel block streams.
  let active = 0,
    networkActive = 0,
    networkStart = 0,
    networkMs = 0;
  const waiters: (() => void)[] = [];
  const runtime = options.runtime;
  const memoryHeadroom = Math.max(
    0,
    104 * 1024 * 1024 - index.bytes.length - workingBytes,
  );
  runtime?.setLimit(memoryHeadroom);
  const read: Read = async (
    e: (typeof entries)[number],
    positions: boolean,
    relative: number,
    length: number,
  ) => {
    const object = positions ? e.positionObject : e.object,
      offset = (positions ? e.positionOffset : e.offset) + relative;
    if (object === LOCAL) {
      return index.localPosting(e, positions, relative, length);
    }
    const rangeKey = JSON.stringify([
      index.generation,
      "range",
      positions ? e.positionCrc : e.crc,
      object,
      positions,
      offset,
      length,
    ]);
    const cached =
      stage >= 6 && options.blockCache !== false
        ? runtime?.get<Uint8Array>(rangeKey)
        : undefined;
    if (cached) {
      diagnostics.postingCacheHits++;
      return cached;
    }
    if (active >= 4)
      await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
    if (networkActive++ === 0) networkStart = performance.now();
    try {
      diagnostics.indexRequests++;
      diagnostics.indexBytes += length;
      if (positions) {
        diagnostics.positionRequests++;
        diagnostics.positionBytes += length;
      } else {
        diagnostics.frequencyRequests++;
        diagnostics.frequencyBytes += length;
      }
      const bytes = await storage.read(
        index.key(object, positions ? "positions" : "frequencies"),
        offset,
        length,
      );
      if (stage >= 6 && options.blockCache !== false && length <= 262144)
        runtime?.set(rangeKey, bytes, bytes.byteLength);
      return bytes;
    } finally {
      if (--networkActive === 0) networkMs += performance.now() - networkStart;
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
  if ((options.pagedOptimizationStep ?? index.optimizationStep) >= 6)
    read.plan = {
      latencyMs: options.r2LatencyMs ?? 20,
      bandwidthMiB: options.r2BandwidthMiB ?? 50,
      lanes: Math.max(1, Math.floor(4 / entries.length)),
    };
  if (streaming) {
    const heap = new TopK(limit);
    const execution = performance.now();
    const stats = await searchBlocks(
      index,
      entries,
      ast,
      read,
      heap,
      limit,
      options.field ?? "all",
      boost,
      stage >= 6 && options.blockCache !== false ? runtime : undefined,
      wantWand ? "wand" : "boolean",
    );
    diagnostics.executor = wantWand ? "wand" : "boolean-blocks";
    diagnostics.wandPivots = stats.wandPivots;
    diagnostics.wandSkips = stats.wandSkips;
    diagnostics.visitedDocuments = stats.visitedDocuments;
    diagnostics.cursorSeeks = stats.cursorSeeks;
    diagnostics.cursorLoads = stats.cursorLoads;
    diagnostics.blocksDecoded = stats.blocksDecoded;
    diagnostics.blockCacheHits = stats.blockCacheHits;
    diagnostics.fullPostingCacheHits = stats.fullPostingCacheHits;
    diagnostics.scoredDocuments = stats.scored;
    diagnostics.skippedBlocks = stats.skippedBlocks;
    diagnostics.cacheBytes = runtime?.bytes ?? 0;
    diagnostics.fetchMs = networkMs;
    diagnostics.scoreMs = Math.max(
      0,
      performance.now() - execution - networkMs,
    );
    diagnostics.fullyLocal = diagnostics.indexRequests === 0;
    await index.resolveDocuments(
      heap.heap.map((h) => h.doc),
      storage,
    );
    const results = heap.heap
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .map((h) => ({ id: index.document(h.doc).id, score: h.score }));
    return {
      results: results as Omit<Hit, "doc">[],
      ...(exactTotal ? { total: 0 } : {}),
      diagnostics,
    };
  }
  const adaptive = options.planning !== "legacy";
  const cacheKey = (e: (typeof entries)[number], positions: boolean) =>
    postingKey(index.generation, e, positions);
  const load = async (
    e: (typeof entries)[number],
    positions: boolean,
    candidates?: Uint32Array,
  ) => {
    const key = cacheKey(e, positions),
      cached =
        runtime?.get<Awaited<ReturnType<typeof loadPosting>>>(key) ??
        (!positions
          ? runtime?.get<Awaited<ReturnType<typeof loadPosting>>>(
              cacheKey(e, true),
            )
          : undefined);
    if (cached) {
      diagnostics.postingCacheHits++;
      return cached;
    }
    diagnostics.postingCacheMisses++;
    const list = await loadPosting(e, positions, read, candidates, adaptive);
    if (list.docs.length === e.df) runtime?.set(key, list, postingSize(list));
    return list;
  };
  const plan = adaptive
    ? candidatePlan(ast, (t) => index.lookup(t)!.df)
    : undefined;
  const required = requiredTerms(ast),
    anchor = entries
      .filter((e) => required.has(e.term))
      .sort((a, b) => a.df - b.df)[0];
  const maxDf = Math.max(0, ...entries.map((e) => e.df));
  const planned =
    skipBlocks && plan && maxDf > Math.max(256, plan.estimate * 8);
  const selective =
    skipBlocks && anchor && maxDf > Math.max(256, anchor.df * 8);
  const competitive =
    options.competitivePositions === true && needsPositions && !exactTotal;
  const defer = adaptive && needsPositions && (!!planned || competitive);
  diagnostics.deferredPositions = defer;
  const prepared = new Map<string, Awaited<ReturnType<typeof loadPosting>>>();
  let plannedCandidates: Uint32Array | undefined;
  if (planned) {
    await parallel(
      entries.filter((e) => plan.terms.has(e.term)),
      4,
      async (e) => {
        prepared.set(
          e.term,
          await load(e, !defer && positionTerms.has(e.term)),
        );
      },
    );
    plannedCandidates = candidateDocuments(
      plan.node,
      prepared,
      index.count,
      options.field ?? "all",
      true,
    );
  } else if (selective) {
    const list = await load(anchor, !defer && positionTerms.has(anchor.term));
    prepared.set(anchor.term, list);
    plannedCandidates = list.docs;
  }
  let lists = await parallel(
    entries,
    4,
    async (e) =>
      prepared.get(e.term) ??
      load(e, !defer && positionTerms.has(e.term), plannedCandidates),
  );
  if (defer && !competitive) {
    const coarse = candidateDocuments(
      ast,
      new Map(entries.map((e, i) => [e.term, lists[i]])),
      index.count,
      options.field ?? "all",
      false,
    );
    lists = await parallel(
      entries.map((e, i) => ({ e, i })),
      4,
      async ({ e, i }) => {
        if (!positionTerms.has(e.term)) return lists[i];
        const cached = runtime?.get<Awaited<ReturnType<typeof loadPosting>>>(
          cacheKey(e, true),
        );
        if (cached) {
          diagnostics.postingCacheHits++;
          return cached;
        }
        const attached = await attachCandidatePositions(
          e,
          lists[i],
          read,
          coarse,
        );
        if (attached.positionsComplete && attached.docs.length === e.df)
          runtime?.set(cacheKey(e, true), attached, postingSize(attached));
        return attached;
      },
    );
  }
  runtime?.setLimit(memoryHeadroom);
  if (
    needsPositions &&
    workingBytes +
      lists.reduce((sum, l) => {
        if (!l.positionOffsets) return sum;
        let bodyMax = 0,
          titleMax = 0;
        for (let i = 0; i < l.docs.length; i++) {
          bodyMax = Math.max(bodyMax, l.body[i]);
          titleMax = Math.max(titleMax, l.title[i]);
        }
        return sum + (bodyMax + titleMax) * 8;
      }, 0) >
      Math.min(56 * 1024 * 1024, 104 * 1024 * 1024 - index.bytes.length)
  )
    throw new Error("Position decoding exceeds memory budget");
  diagnostics.fetchMs = performance.now() - fetchStart;
  const scoring = performance.now();
  const byTerm = new Map(entries.map((e, i) => [e.term, lists[i]]));
  let candidates = candidateDocuments(
    ast,
    byTerm,
    index.count,
    options.field ?? "all",
    !needsPositions,
  );
  if (needsPositions && exactTotal)
    candidates = candidates.filter(
      positionalMatcher(ast, byTerm, options.field ?? "all"),
    );
  // Compile positive terms once; preserve term order and BM25 operation order.
  const scoringTerms = entries.flatMap((e, j) =>
    positiveTerms.has(e.term)
      ? [
          {
            term: e.term,
            list: lists[j],
            cursor: 0,
            idf: Math.log(1 + (index.count - e.df + 0.5) / (e.df + 0.5)),
          },
        ]
      : [],
  );
  const heap = new TopK(limit),
    lengths = { body: 0, title: 0 },
    bodyEnabled = options.field !== "title",
    titleEnabled = options.field !== "body",
    avgBody = index.avgBody || 1,
    avgTitle = index.avgTitle || 1;
  const boundsStart = performance.now();
  // Building bounds scans every posting; direct scoring wins on small or
  // very selective candidate sets. Cached bounds remain cheap for larger sets.
  const boundRows = scoringTerms.reduce(
    (sum, term) => sum + term.list.docs.length,
    0,
  );
  const useBounds =
    !competitive &&
    !exactTotal &&
    (stage < 3 ||
      (candidates.length >= 1024 && boundRows <= candidates.length * 8));
  await index.prepareLengths(
    candidates,
    storage,
    useBounds ? scoringTerms.map((t) => t.list.docs) : [],
  );
  const bounds = useBounds
    ? scoringTerms.map((term) => {
        const e = entries.find((e) => e.term === term.term)!;
        const result = scoreBounds(index, e, term.list, term.idf, runtime);
        if (result.hit) diagnostics.boundsCacheHits++;
        return result.bounds;
      })
    : undefined;
  diagnostics.boundsMs = performance.now() - boundsStart;
  const match =
    needsPositions && !exactTotal && !competitive
      ? positionalMatcher(ast, byTerm, options.field ?? "all")
      : undefined;
  const ranked: { doc: number; score: number }[] = [];
  let bucket = -1,
    upper = 0;
  for (
    let candidateIndex = 0;
    candidateIndex < candidates.length;
    candidateIndex++
  ) {
    const doc = candidates[candidateIndex];
    if (bounds && heap.heap.length === limit) {
      const current = Math.floor(doc / SCORE_BLOCK);
      if (current !== bucket) {
        bucket = current;
        upper = 0;
        for (let j = 0; j < bounds.length; j++) {
          if (bodyEnabled) upper += bounds[j][bucket * 2];
          if (titleEnabled) upper += boost * bounds[j][bucket * 2 + 1];
        }
      }
      const threshold = heap.heap[0];
      if (
        upper < threshold.score ||
        (upper === threshold.score && doc > threshold.doc)
      ) {
        const next = lowerBound(
          candidates,
          (bucket + 1) * SCORE_BLOCK,
          candidateIndex + 1,
        );
        diagnostics.prunedCandidates += next - candidateIndex;
        candidateIndex = next - 1;
        continue;
      }
    }
    if (stage < 2 && match && !match(doc)) continue;
    diagnostics.visitedDocuments++;
    diagnostics.scoredDocuments++;
    if (doc >= index.count) throw new Error("Posting document out of range");
    const d = index.lengths(doc, lengths),
      bodyNorm = 1.2 * (1 - 0.75 + (0.75 * d.body) / avgBody),
      titleNorm = 1.2 * (1 - 0.75 + (0.75 * d.title) / avgTitle);
    let score = 0;
    for (let j = 0; j < scoringTerms.length; j++) {
      const term = scoringTerms[j],
        l = term.list;
      let p = term.cursor;
      let steps = 0;
      while (
        p < l.docs.length &&
        l.docs[p] < doc &&
        steps++ < (stage >= 1 ? 8 : Infinity)
      )
        p++;
      if (p < l.docs.length && l.docs[p] < doc) p = lowerBound(l.docs, doc, p);
      term.cursor = p;
      if (l.docs[p] !== doc) continue;
      const body = l.body[p],
        title = l.title[p];
      if (bodyEnabled && body)
        score += (term.idf * (body * 2.2)) / (body + bodyNorm);
      if (titleEnabled && title)
        score += boost * ((term.idf * (title * 2.2)) / (title + titleNorm));
    }
    if (stage >= 2 && match) {
      const threshold = heap.heap.length === limit ? heap.heap[0] : undefined;
      if (
        threshold &&
        (score < threshold.score ||
          (score === threshold.score && doc > threshold.doc))
      )
        continue;
      if (!match(doc)) continue;
    }
    if (competitive) ranked.push({ doc, score });
    else heap.add(doc, score);
  }
  if (competitive) {
    ranked.sort((a, b) => b.score - a.score || a.doc - b.doc);
    for (let first = 0, round = 0; first < ranked.length; round++) {
      const threshold = heap.heap.length === limit ? heap.heap[0] : undefined,
        next = ranked[first];
      if (
        threshold &&
        (next.score < threshold.score ||
          (next.score === threshold.score && next.doc >= threshold.doc))
      )
        break;
      const batch = ranked.slice(
          first,
          first + (round === 0 ? 64 : round === 1 ? 256 : ranked.length),
        ),
        docs = Uint32Array.from(batch.map((h) => h.doc).sort((a, b) => a - b));
      const attached = await parallel(
        entries.map((e, i) => ({ e, i })),
        4,
        async ({ e, i }) =>
          positionTerms.has(e.term)
            ? attachCandidatePositions(e, lists[i], read, docs)
            : lists[i],
      );
      const verify = positionalMatcher(
        ast,
        new Map(entries.map((e, i) => [e.term, attached[i]])),
        options.field ?? "all",
      );
      for (const hit of batch)
        if (verify(hit.doc)) heap.add(hit.doc, hit.score);
      first += batch.length;
    }
  }
  await index.resolveDocuments(
    heap.heap.map((h) => h.doc),
    storage,
    options.metadata === true,
  );
  for (const h of heap.heap) h.id = index.document(h.doc).id;
  const hits = heap.heap.sort((a, b) => b.score - a.score || a.doc - b.doc);
  diagnostics.scoreMs = performance.now() - scoring;
  if (options.metadata)
    await parallel(hits, 4, async (h) => {
      const d = index.document(h.doc);
      diagnostics.metadataRequests++;
      diagnostics.metadataBytes += d.metaLength;
      const bytes = await storage.read(
        index.key(d.metaObject, "metadata"),
        d.metaOffset,
        d.metaLength,
      );
      const m = JSON.parse(decoder.decode(bytes));
      if (m.id !== h.id) throw new Error("Metadata identity mismatch");
      h.metadata = m.metadata;
      h.title = m.title;
    });
  runtime?.setLimit(memoryHeadroom);
  diagnostics.cacheBytes = runtime?.bytes ?? 0;
  diagnostics.fullyLocal =
    diagnostics.indexRequests + diagnostics.metadataRequests === 0;
  return {
    results: hits.map(({ doc, ...h }) => h),
    ...(!exactTotal ? {} : { total: candidates.length }),
    diagnostics,
  };
}

export async function search(
  index: BinaryIndex,
  storage: Storage,
  q: string,
  options: SearchOptions = {},
  skipBlocks = true,
) {
  const view = index.queryIndex();
  if (view.paged && options.pagedReadPolicy)
    view.pagedReadPolicy = options.pagedReadPolicy;
  const result = await executeSearch(view, storage, q, options, skipBlocks);
  const pages = view as BinaryIndex & {
    pageRequests?: number;
    pageBytes?: number;
  };
  const dictionaryDocumentRequests = pages.pageRequests ?? 0;
  const dictionaryDocumentBytes = pages.pageBytes ?? 0;
  result.diagnostics.indexRequests += dictionaryDocumentRequests;
  result.diagnostics.indexBytes += dictionaryDocumentBytes;
  result.diagnostics.fullyLocal =
    result.diagnostics.indexRequests + result.diagnostics.metadataRequests ===
    0;
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      paged: view.paged,
      pagedReadPolicy: view.paged ? view.pagedReadPolicy : undefined,
      dictionaryDocumentRequests,
      dictionaryDocumentBytes,
    },
  };
}
