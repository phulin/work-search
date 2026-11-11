import { candidatePlan } from "./planning.js";
import { lowerBound } from "./sets.js";
import { SearchRuntime, postingSize } from "./runtime.js";
import { scoreBounds, SCORE_BLOCK } from "./pruning.js";
import {
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
  mode?: "and" | "or";
  limit?: number;
  titleBoost?: number;
  field?: "all" | "title" | "body";
  metadata?: boolean;
  exactTotal?: boolean;
  planning?: "legacy" | "adaptive";
  runtime?: SearchRuntime;
}
export async function search(
  index: BinaryIndex,
  storage: Storage,
  q: string,
  options: SearchOptions = {},
  skipBlocks = true,
) {
  const exactTotal = options.exactTotal === true;
  const start = performance.now(),
    original = parse(q, options.mode ?? "and"),
    ast = simplify(original, (t) => !!index.lookup(t)),
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
  };
  if (ast.kind === "empty")
    return {
      results: [],
      ...(!exactTotal ? {} : { total: 0 }),
      diagnostics,
    };
  const entries = found.filter((x) => x !== undefined),
    fetchStart = performance.now();
  const workingBytes =
    entries.reduce(
      (s, e) =>
        s +
        e.length +
        e.df * 20 +
        (positionTerms.has(e.term) ? e.positionLength + e.df * 4 : 0),
      0,
    ) + (needsUniverse(ast) ? index.count * 8 : 0);
  if (
    workingBytes >
    Math.min(56 * 1024 * 1024, 104 * 1024 * 1024 - index.bytes.length)
  )
    throw new Error("Query working set exceeds memory budget");
  // All phases share one four-read semaphore, including parallel block streams.
  let active = 0;
  const waiters: (() => void)[] = [];
  const read = async (
    e: (typeof entries)[number],
    positions: boolean,
    relative: number,
    length: number,
  ) => {
    const object = positions ? e.positionObject : e.object,
      offset = (positions ? e.positionOffset : e.offset) + relative;
    if (object === LOCAL) {
      const start = index.local + offset;
      if (start + length > index.bytes.length)
        throw new Error("Invalid local range");
      return index.bytes.subarray(start, start + length);
    }
    if (active >= 4)
      await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
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
      return await storage.read(
        index.key(object, positions ? "positions" : "frequencies"),
        offset,
        length,
      );
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
  const runtime = options.runtime;
  const memoryHeadroom = Math.max(
    0,
    104 * 1024 * 1024 - index.bytes.length - workingBytes,
  );
  runtime?.setLimit(memoryHeadroom);
  const adaptive = options.planning !== "legacy";
  const cacheKey = (e: (typeof entries)[number], positions: boolean) =>
    JSON.stringify([
      index.generation,
      "posting",
      e.term,
      e.df,
      e.crc,
      e.positionCrc,
      positions,
    ]);
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
  const defer = adaptive && needsPositions && !!planned;
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
    const list = await load(anchor, positionTerms.has(anchor.term));
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
  if (defer) {
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
  const bounds = !exactTotal
    ? scoringTerms.map((term) => {
        const e = entries.find((e) => e.term === term.term)!;
        const result = scoreBounds(index, e, term.list, term.idf, runtime);
        if (result.hit) diagnostics.boundsCacheHits++;
        return result.bounds;
      })
    : undefined;
  diagnostics.boundsMs = performance.now() - boundsStart;
  const match =
    needsPositions && !exactTotal
      ? positionalMatcher(ast, byTerm, options.field ?? "all")
      : undefined;
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
    if (match && !match(doc)) continue;
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
      while (p < l.docs.length && l.docs[p] < doc) p++;
      term.cursor = p;
      if (l.docs[p] !== doc) continue;
      const body = l.body[p],
        title = l.title[p];
      if (bodyEnabled && body)
        score += (term.idf * (body * 2.2)) / (body + bodyNorm);
      if (titleEnabled && title)
        score += boost * ((term.idf * (title * 2.2)) / (title + titleNorm));
    }
    heap.add(doc, score);
  }
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
