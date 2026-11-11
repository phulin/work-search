import { BinaryIndex, LOCAL } from "../format/index.js";
import { crc32, decodePostings, decoder } from "../format/codec.js";
import {
  parse,
  queryTerms,
  positional,
  simplify,
  needsUniverse,
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
  add(h: Hit) {
    const a = this.heap;
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
}
export async function search(
  index: BinaryIndex,
  storage: Storage,
  q: string,
  options: SearchOptions = {},
) {
  const start = performance.now(),
    original = parse(q, options.mode ?? "and"),
    ast = simplify(original, (t) => !!index.lookup(t)),
    terms = queryTerms(ast),
    positiveTerms = new Set(queryTerms(ast, true)),
    needsPositions = positional(ast),
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
    metadataRequests: 0,
    metadataBytes: 0,
    fullyLocal: true,
  };
  if (ast.kind === "empty") return { results: [], total: 0, diagnostics };
  const entries = found.filter((x) => x !== undefined),
    fetchStart = performance.now();
  const workingBytes =
    entries.reduce(
      (s, e) => s + e.length + e.df * (needsPositions ? 24 : 20),
      0,
    ) + (needsUniverse(ast) ? index.count * 8 : 0);
  if (
    workingBytes >
    Math.min(56 * 1024 * 1024, 104 * 1024 * 1024 - index.bytes.length)
  )
    throw new Error("Query working set exceeds memory budget");
  const lists = await parallel(entries, 4, async (e) => {
    let bytes: Uint8Array;
    if (e.object === LOCAL) {
      const p = index.local + e.offset;
      if (p + e.length > index.bytes.length)
        throw new Error("Invalid local range");
      bytes = index.bytes.subarray(p, p + e.length);
    } else {
      diagnostics.indexRequests++;
      diagnostics.indexBytes += e.length;
      bytes = await storage.read(index.key(e.object), e.offset, e.length);
    }
    if (crc32(bytes) !== e.crc) throw new Error("Posting checksum mismatch");
    return decodePostings(bytes, e.df, needsPositions);
  });
  if (
    needsPositions &&
    workingBytes +
      lists.reduce((sum, l) => {
        let max = 0;
        for (let i = 0; i < l.docs.length; i++)
          max = Math.max(max, l.body[i] + l.title[i]);
        return sum + max * 4;
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
  if (needsPositions)
    candidates = candidates.filter(
      positionalMatcher(ast, byTerm, options.field ?? "all"),
    );
  const cursors = lists.map(() => 0),
    heap = new TopK(limit),
    lengths = { body: 0, title: 0 };
  for (const doc of candidates) {
    if (doc >= index.count) throw new Error("Posting document out of range");
    const d = index.lengths(doc, lengths);
    let score = 0;
    lists.forEach((l, j) => {
      if (!positiveTerms.has(entries[j].term)) return;
      let p = cursors[j];
      while (p < l.docs.length && l.docs[p] < doc) p++;
      cursors[j] = p;
      if (l.docs[p] === doc) {
        if (options.field !== "title")
          score += bm25(
            l.body[p],
            entries[j].df,
            index.count,
            d.body,
            index.avgBody,
          );
        if (options.field !== "body")
          score +=
            boost *
            bm25(
              l.title[p],
              entries[j].df,
              index.count,
              d.title,
              index.avgTitle,
            );
      }
    });
    heap.add({ id: "", score, doc });
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
  diagnostics.fullyLocal =
    diagnostics.indexRequests + diagnostics.metadataRequests === 0;
  return {
    results: hits.map(({ doc, ...h }) => h),
    total: candidates.length,
    diagnostics,
  };
}
