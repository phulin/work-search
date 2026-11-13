import {
  candidateDocuments,
  positionalMatcher,
  QueryResourceError,
} from "../query/evaluate.js";
import {
  queryTerms,
  positional,
  positionalTerms,
  needsUniverse,
  type Node,
} from "../query/parser.js";
import type { DecodedPostings } from "../format/codec.js";
import {
  decodeScores,
  lower,
  view,
  unpack,
  type Root,
  type Ref,
  type PositionalPair,
} from "./format.js";
import { readPairAnchor } from "./pair-execution.js";
import { planPairAnchor, pairPhraseEvidence } from "./pair-evidence.js";
import { decodeTermPacket } from "./term-packet.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { DocumentPackage } from "./document-package.js";
import type { Reader } from "./storage.js";
import type { Options } from "./search.js";
import { renderResults } from "./render.js";
import { Heap, type Hit } from "./top-k.js";
import { bm25 } from "../query/engine.js";
export interface CandidatePackages {
  averageBytes: number;
  load(doc: number): Promise<DocumentPackage>;
}
interface Columns {
  docs: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  b: Float64Array;
  t: Float64Array;
  position(
    row: number,
    field: number,
    data: Uint8Array | ((ref: Ref) => Uint8Array),
  ): Uint32Array;
}
function columns(raw: Uint8Array, id: number, positionBase: Ref): Columns {
  if (view(raw).getUint32(0, true) === 0x33465443)
    return decodeTermPacket(Uint8Array.from(raw), id, positionBase);
  const s = decodeScores(raw),
    b = new Float64Array(s.docs.length),
    t = new Float64Array(s.docs.length);
  for (let i = 0; i < b.length; i++) {
    b[i] = s.b.getFloat64(i * 8, true);
    t[i] = s.t.getFloat64(i * 8, true);
  }
  return {
    docs: s.docs,
    body: s.body,
    title: s.title,
    b,
    t,
    position(row, field, data) {
      if (typeof data === "function") data = data(positionBase);
      const v = view(data),
        n = v.getUint32(0, true),
        base = 4 + (n + 1) * 4;
      if (n !== s.docs.length || row < 0 || row >= n)
        throw Error("Invalid leaf position row");
      const from = base + v.getUint32(4 + row * 4, true),
        end = base + v.getUint32(8 + row * 4, true),
        bn = v.getUint32(from, true);
      if (from + 4 + bn > end || end > data.length)
        throw Error("Invalid leaf position span");
      return unpack(
        field
          ? data.subarray(from + 4 + bn, end)
          : data.subarray(from + 4, from + 4 + bn),
      );
    },
  };
}
const frequencyRefs = (term: DirectoryTerm) => [
  term.frequencies,
  ...(term.frequencyParts ?? []),
];
const frequencyBytesOf = (term: DirectoryTerm) =>
  frequencyRefs(term).reduce((n, r) => n + r[2], 0);
const positionRefs = (term: DirectoryTerm) => [
  term.positional,
  ...(term.positionalParts ?? []),
];
function completeColumns(
  term: DirectoryTerm,
  raw: Uint8Array[],
  reader: Reader,
): Columns {
  const refs = frequencyRefs(term),
    parts = raw.map((data, i) =>
      reader.decoded(
        refs[i],
        data,
        (bytes) => columns(bytes, term.id, term.positional),
        data.length + (term.df * 28) / refs.length,
        "packet:",
      ),
    );
  if (parts.length === 1) {
    if (parts[0].docs.length !== term.df)
      throw Error("Complete packet DF mismatch");
    return parts[0];
  }
  const docs = new Uint32Array(term.df),
    body = new Uint32Array(term.df),
    title = new Uint32Array(term.df),
    b = new Float64Array(term.df),
    t = new Float64Array(term.df),
    positionParts: {
      first: number;
      last: number;
      position: Columns["position"];
    }[] = [];
  let at = 0;
  for (const part of parts) {
    if (at + part.docs.length > term.df || (at && part.docs[0] <= docs[at - 1]))
      throw Error("Invalid complete packet order");
    docs.set(part.docs, at);
    body.set(part.body, at);
    title.set(part.title, at);
    b.set(part.b, at);
    t.set(part.t, at);
    positionParts.push({
      first: at,
      last: at + part.docs.length,
      position: part.position,
    });
    at += part.docs.length;
  }
  if (at !== term.df) throw Error("Complete packet DF mismatch");
  return {
    docs,
    body,
    title,
    b,
    t,
    position(row, field, data) {
      const p = positionParts.find((p) => p.first <= row && row < p.last);
      if (!p) throw Error("Invalid complete position row");
      return p.position(row - p.first, field, data);
    },
  };
}
async function readTerms(
  names: string[],
  terms: Map<string, DirectoryTerm>,
  reader: Reader,
  wantedPositions: Set<string>,
) {
  const refs: Ref[] = [],
    frequencyData = new Map<string, number[]>(),
    positionData = new Map<string, { ref: Ref; at: number }[]>();
  for (const name of names) {
    frequencyData.set(
      name,
      frequencyRefs(terms.get(name)!).map((ref) => {
        refs.push(ref);
        return refs.length - 1;
      }),
    );
    if (wantedPositions.has(name))
      positionData.set(
        name,
        positionRefs(terms.get(name)!).map((ref) => {
          refs.push(ref);
          return { ref, at: refs.length - 1 };
        }),
      );
  }
  const data = await reader.packets(refs),
    cols = names.map((name) =>
      completeColumns(
        terms.get(name)!,
        frequencyData.get(name)!.map((i) => data[i]),
        reader,
      ),
    );
  return {
    cols,
    resolve: (name: string, ref: Ref) => {
      const span = positionData
        .get(name)
        ?.find(
          (span) =>
            span.ref[0] === ref[0] &&
            span.ref[1] <= ref[1] &&
            span.ref[1] + span.ref[2] >= ref[1] + ref[2],
        );
      if (!span) throw Error("Position outside complete packet spans");
      return data[span.at].subarray(
        ref[1] - span.ref[1],
        ref[1] - span.ref[1] + ref[2],
      );
    },
  };
}
export function mandatoryTerms(ast: Node): Set<string> {
  if (ast.kind === "term") return new Set([ast.term]);
  if (ast.kind === "phrase") return new Set(ast.terms);
  if (!("left" in ast)) return new Set();
  const a = mandatoryTerms(ast.left),
    b = mandatoryTerms(ast.right);
  if (ast.kind === "or") return new Set([...a].filter((t) => b.has(t)));
  return ast.kind === "except" ? a : new Set([...a, ...b]);
}
export interface PacketPlan {
  kind: "complete-terms" | "documents" | "blocks";
  frequencyBytes: number;
  positionBytes: number;
  expectedCandidates: number;
  expectedDocumentBytes: number;
  gets: number;
  dependentStages: number;
  anchor?: string;
  anchors?: string[];
  pairAnchors?: PositionalPair[];
  phraseAnchor?: string[];
}
function anchorsFor(
  ast: Node,
  terms: Map<string, DirectoryTerm>,
  root: Root,
  averageBytes: number,
) {
  const choices = [...mandatoryTerms(ast)]
    .map((name) => ({ name, term: terms.get(name)! }))
    .filter((a) => a.term?.frequencies[2])
    .sort(
      (a, b) =>
        frequencyBytesOf(a.term) +
        a.term.df * averageBytes -
        (frequencyBytesOf(b.term) + b.term.df * averageBytes),
    );
  const anchors = choices.slice(0, 1);
  let candidates = anchors[0]?.term.df ?? root.count,
    bytes = anchors.length ? frequencyBytesOf(anchors[0].term) : 0;
  for (const choice of choices.slice(1)) {
    const size = frequencyBytesOf(choice.term),
      expected = (candidates * choice.term.df) / root.count,
      saved = (candidates - expected) * (averageBytes / 262144 + 2 / 6),
      cost = size / 262144 + 2;
    if (anchors.length < 8 && bytes + size <= 1048576 && saved > cost) {
      anchors.push(choice);
      candidates = expected;
      bytes += size;
    }
  }
  return { anchors, candidates: Math.ceil(candidates), bytes };
}
export function packetPlan(
  ast: Node,
  terms: Map<string, DirectoryTerm>,
  root: Root,
  options: Options,
  packages?: CandidatePackages,
  preferred?: "complete-terms" | "documents",
): PacketPlan {
  const wantedPositions = positionalTerms(ast);
  const positionalQuery = positional(ast),
    all = [...terms.values()],
    frequencyBytes = all.reduce(
      (n, t) => n + frequencyRefs(t).reduce((s, r) => s + r[2], 0),
      0,
    ),
    positionBytes = positionalQuery
      ? [...terms]
          .filter(([name]) => wantedPositions.has(name))
          .reduce(
            (n, [, t]) => n + positionRefs(t).reduce((s, r) => s + r[2], 0),
            0,
          )
      : 0,
    complete = all.every(
      (t) =>
        t.frequencies[2] > 0 &&
        (![...terms].some(
          ([name, term]) => term === t && wantedPositions.has(name),
        ) ||
          t.positional[2] > 0),
    ),
    selected = anchorsFor(ast, terms, root, packages?.averageBytes ?? 16384),
    anchor = selected.anchors[0],
    candidateCount = selected.candidates,
    documentBytes = candidateCount * (packages?.averageBytes ?? 16384),
    occurrences = [...terms]
      .filter(([name]) => wantedPositions.has(name))
      .reduce((n, [, t]) => n + t.bodyOccurrences + t.titleOccurrences, 0),
    // Starting priors, to be fitted from the live crossover experiments. GETs
    // overlap six at a time; dependent phases remain serial.
    termCost =
      (frequencyBytes + positionBytes) / 262144 +
      Math.ceil((all.length * (positionalQuery ? 2 : 1)) / 6) * 2 +
      2 +
      (positionalQuery ? occurrences / 50000 : 0),
    documentCost =
      selected.bytes / 262144 +
      documentBytes / 262144 +
      Math.ceil((candidateCount + 1) / 6) * 2 +
      2 +
      (positionalQuery ? (candidateCount * root.avgBody) / 50000 : 0),
    memory =
      all.reduce((n, t) => n + t.df * 64, 0) +
      frequencyBytes +
      (positionalQuery ? occurrences * 4 : 0) +
      positionBytes +
      (needsUniverse(ast) ? root.count * 4 : 0),
    completeFits =
      complete &&
      frequencyBytes + positionBytes <= 8 * 1048576 &&
      memory <= 24 * 1048576;
  const pair = planPairAnchor(
      ast,
      new Map([...terms].map(([name, t]) => [name, t.id])),
      root,
    ),
    pairBytes = pair
      ? pair.bytes + pair.df * (packages?.averageBytes ?? 16384)
      : Infinity;
  const pairCost = pair
    ? pairBytes / 262144 + Math.ceil(pair.df / 6) * 2 + 2
    : Infinity;
  if (
    packages &&
    preferred !== "complete-terms" &&
    pair &&
    ((pair.df <= 512 && pairBytes <= 8 * 1048576) ||
      pair.covered ||
      // A short context scan can shrink a loose DF upper bound dramatically.
      // Decide whether candidate packages fit after exact context rejection;
      // otherwise retain the same evidence in the block fallback.
      ((!completeFits || preferred === "documents") &&
        pair.words.length > 2 &&
        pair.bytes * 4 <= frequencyBytes + positionBytes)) &&
    (!completeFits || preferred === "documents" || pairCost < termCost) &&
    (pairBytes < documentBytes + selected.bytes ||
      (pair.covered && (candidateCount > 512 || documentBytes > 8 * 1048576)))
  )
    return {
      kind: "documents",
      frequencyBytes: pair.bytes,
      positionBytes: 0,
      expectedCandidates: pair.df,
      expectedDocumentBytes: pair.df * packages.averageBytes,
      gets: pair.pairs.length + pair.df,
      dependentStages: 2,
      pairAnchors: pair.pairs,
      phraseAnchor: pair.words,
    };
  // Initial transfer/memory budgets are benchmark parameters to be calibrated,
  // never candidate truncation. A plan must cover the complete predicate.
  if (
    packages &&
    preferred !== "complete-terms" &&
    anchor &&
    selected.bytes <= 1048576 &&
    candidateCount <= 512 &&
    documentBytes <= 8 * 1048576 &&
    (!completeFits || documentCost < termCost || preferred === "documents")
  )
    return {
      kind: "documents",
      frequencyBytes: selected.bytes,
      positionBytes: 0,
      expectedCandidates: candidateCount,
      expectedDocumentBytes: documentBytes,
      gets: selected.anchors.length + candidateCount,
      dependentStages: 2,
      anchor: anchor.name,
      anchors: selected.anchors.map((a) => a.name),
    };
  if (completeFits && preferred !== "documents")
    return {
      kind: "complete-terms",
      frequencyBytes,
      positionBytes,
      expectedCandidates: candidateCount,
      expectedDocumentBytes: 0,
      gets: all.length * (positionalQuery ? 2 : 1) + (options.limit ?? 20),
      dependentStages: 2,
    };
  return {
    kind: "blocks",
    frequencyBytes,
    positionBytes,
    expectedCandidates: candidateCount,
    expectedDocumentBytes: documentBytes,
    gets: 0,
    dependentStages: 0,
  };
}
export async function packageResult(
  pkg: DocumentPackage,
  hit: Hit,
  positive: Set<number>,
  options: Options,
) {
  const record = await pkg.display();
  return {
    id: record.id,
    doc: hit.doc,
    score: hit.score,
    ...(options.metadata !== false
      ? { title: record.title, metadata: record.metadata }
      : {}),
    ...(options.snippets !== false
      ? { snippet: await pkg.snippet(positive, hit.first, hit.titleOnly) }
      : {}),
  };
}
/** Complete coverage with one transfer phase for term data, followed by winner
 * rendering; or an anchor phase followed by self-contained candidate packages. */
export async function executePackets(
  ast: Node,
  terms: Map<string, DirectoryTerm>,
  root: Root,
  reader: Reader,
  options: Options,
  packages?: CandidatePackages,
  preferred?: "complete-terms" | "documents" | PacketPlan,
) {
  const plan =
    typeof preferred === "object"
      ? preferred
      : packetPlan(ast, terms, root, options, packages, preferred);
  if (plan.kind === "blocks") return;
  const names = queryTerms(ast),
    positive = new Set(queryTerms(ast, true)),
    positiveIds = new Set([...positive].map((n) => terms.get(n)!.id)),
    field = options.field ?? "all",
    boost = options.titleBoost ?? 2,
    limit = options.limit ?? 20,
    heap = new Heap(limit),
    positions = positional(ast),
    started = performance.now();
  let total = 0;
  const eligible = (doc: number, score: number) =>
    !options.after ||
    score < options.after.score ||
    (score === options.after.score && doc > options.after.doc);
  const admitted = (doc: number, score: number) =>
    eligible(doc, score) && (options.exactTotal || heap.accepts(doc, score));
  const wantedPositions = positionalTerms(ast),
    positionalIds = new Set([...wantedPositions].map((n) => terms.get(n)!.id));
  const firstSpan = (
    match: ReturnType<typeof positionalMatcher>,
    doc: number,
  ) => {
    try {
      return match.firstBodySpan(doc)?.start;
    } catch (e) {
      if (!(e instanceof QueryResourceError)) throw e;
      return undefined;
    }
  };
  const packageHits = new Map<number, DocumentPackage>();
  let phraseEvidence: ReturnType<typeof pairPhraseEvidence> | undefined;
  if (plan.kind === "documents") {
    let candidates: Uint32Array;
    if (plan.pairAnchors) {
      const pair = await readPairAnchor(
        plan.pairAnchors,
        plan.phraseAnchor!,
        new Map([...terms].map(([name, t]) => [name, t.id])),
        field,
        reader,
      );
      phraseEvidence = pair.evidence;
      wantedPositions.clear();
      positionalIds.clear();
      for (const name of positionalTerms(ast, pair.covered)) {
        wantedPositions.add(name);
        positionalIds.add(terms.get(name)!.id);
      }
      candidates = pair.candidates;
    } else {
      const { cols } = await readTerms(
        plan.anchors ?? [plan.anchor!],
        terms,
        reader,
        new Set(),
      );
      reader.stats.postings += cols.reduce((n, c) => n + c.docs.length, 0);
      const candidateBuffer = new Uint32Array(cols[0].docs.length);
      let n = 0;
      for (let row = 0; row < cols[0].docs.length; row++)
        if (field === "all" || cols[0][field][row])
          candidateBuffer[n++] = cols[0].docs[row];
      for (const c of cols.slice(1)) {
        let write = 0,
          row = 0;
        for (let i = 0; i < n; i++) {
          const doc = candidateBuffer[i];
          while (row < c.docs.length && c.docs[row] < doc) row++;
          if (c.docs[row] === doc && (field === "all" || c[field][row]))
            candidateBuffer[write++] = doc;
        }
        n = write;
      }
      candidates = candidateBuffer.subarray(0, n);
    }
    // An overestimate changes the execution plan; no document is silently lost.
    if (
      candidates.length > 512 ||
      candidates.length * packages!.averageBytes > 8 * 1048576
    )
      return;
    let candidateBytes = 0;
    const batchSize = packages!.averageBytes > 262144 ? 2 : 6;
    for (let from = 0; from < candidates.length; from += batchSize) {
      const docs = candidates.subarray(from, from + batchSize),
        batch = await Promise.all([...docs].map((doc) => packages!.load(doc)));
      candidateBytes += batch.reduce((n, pkg) => n + pkg.bytes.length, 0);
      reader.stats.candidatePackageBytes = candidateBytes;
      reader.stats.stages++;
      if (candidateBytes > 8 * 1048576) return;
      reader.stats.peakActiveBufferBytes = Math.max(
        reader.stats.peakActiveBufferBytes,
        reader.stats.anchorBufferBytes +
          [...new Set([...batch, ...packageHits.values()])].reduce(
            (n, pkg) =>
              n + pkg.bytes.length + 4 * (pkg.bodyLength + pkg.titleLength),
            0,
          ),
      );
      for (let i = 0; i < batch.length; i++) {
        const pkg = batch[i],
          doc = docs[i],
          f = pkg.frequencies(),
          lists = new Map<string, DecodedPostings>();
        let score = 0;
        for (const name of names) {
          const t = terms.get(name)!,
            row = lower(f.ids, t.id),
            present = f.ids[row] === t.id,
            b = present ? f.body[row] : 0,
            title = present ? f.title[row] : 0;
          lists.set(name, {
            docs: present ? Uint32Array.of(doc) : new Uint32Array(),
            body: Uint32Array.of(b),
            title: Uint32Array.of(title),
            bytes: new Uint8Array(),
          });
          if (positive.has(name))
            score +=
              (field !== "title"
                ? bm25(b, t.df, root.count, pkg.bodyLength, root.avgBody)
                : 0) +
              (field !== "body"
                ? boost *
                  bm25(title, t.df, root.count, pkg.titleLength, root.avgTitle)
                : 0);
        }
        reader.stats.candidates++;
        if (!admitted(doc, score)) continue;
        const bodies =
            positionalIds.size && field !== "title"
              ? pkg.positions(positionalIds, 0)
              : undefined,
          titles =
            positionalIds.size && field !== "body"
              ? pkg.positions(positionalIds, 1)
              : undefined;
        const direct = (name: string, _doc: number, f: number) =>
            (f ? titles : bodies)?.get(terms.get(name)!.id),
          match = positionalMatcher(
            ast,
            lists,
            field,
            direct,
            {},
            phraseEvidence,
          );
        if (!match(doc)) continue;
        total++;
        if (!heap.accepts(doc, score)) continue;
        let first: number | undefined;
        if (positions && field !== "title") first = firstSpan(match, doc);
        const titleOnly =
          field === "title" ||
          (field === "all" && ast.kind === "phrase" && first === undefined) ||
          (positive.size > 0 &&
            [...positive].every((n) => {
              const row = lower(f.ids, terms.get(n)!.id);
              return f.ids[row] !== terms.get(n)!.id || !f.body[row];
            }));
        heap.add({ doc, score, row: doc % 4096, first, titleOnly });
        packageHits.set(doc, pkg);
        const surviving = new Set(heap.values.map((h) => h.doc));
        for (const key of packageHits.keys())
          if (!surviving.has(key)) packageHits.delete(key);
        let retained = [...packageHits.values()].reduce(
          (n, pkg) => n + pkg.bytes.length,
          0,
        );
        for (const [key, pkg] of packageHits) {
          if (retained <= 8 * 1048576) break;
          packageHits.delete(key);
          retained -= pkg.bytes.length;
        }
      }
    }
  } else {
    const { cols, resolve } = await readTerms(
      names,
      terms,
      reader,
      wantedPositions,
    );
    const lists = new Map<string, DecodedPostings>(
        names.map((n, i) => [
          n,
          {
            docs: cols[i].docs,
            body: cols[i].body,
            title: cols[i].title,
            bytes: new Uint8Array(),
          },
        ]),
      ),
      index = new Map(names.map((n, i) => [n, i]));
    reader.stats.postings += cols.reduce((n, c) => n + c.docs.length, 0);
    const cache = names.map(() => ({
      doc: -1,
      fields: [undefined, undefined] as (Uint32Array | undefined)[],
    }));
    const direct = (name: string, doc: number, field: number) => {
      if (!wantedPositions.has(name)) return;
      const j = index.get(name)!,
        c = cols[j],
        row = lower(c.docs, doc);
      if (c.docs[row] !== doc) return;
      const x = cache[j];
      if (x.doc !== doc) {
        x.doc = doc;
        x.fields = [undefined, undefined];
      }
      if (!x.fields[field]) {
        x.fields[field] = c.position(row, field, (ref) => resolve(name, ref));
        reader.stats.positionIntegers += x.fields[field]!.length;
      }
      return x.fields[field];
    };
    const candidates = candidateDocuments(
        ast,
        lists,
        root.count,
        field,
        !positions,
      ),
      match = positionalMatcher(
        ast,
        lists,
        field,
        positions ? direct : undefined,
      );
    for (const doc of candidates) {
      reader.stats.candidates++;
      let score = 0,
        body = false;
      for (let j = 0; j < names.length; j++)
        if (positive.has(names[j])) {
          const c = cols[j],
            row = lower(c.docs, doc);
          if (c.docs[row] === doc) {
            score +=
              (field !== "title" ? c.b[row] : 0) +
              (field !== "body" ? boost * c.t[row] : 0);
            body ||= c.body[row] > 0;
          }
        }
      if (!admitted(doc, score) || !match(doc)) continue;
      total++;
      if (!heap.accepts(doc, score)) continue;
      let first: number | undefined;
      if (positions && field !== "title") first = firstSpan(match, doc);
      heap.add({
        doc,
        score,
        row: doc % 4096,
        first,
        titleOnly:
          field === "title" ||
          (field === "all" && ast.kind === "phrase" && first === undefined) ||
          (positive.size > 0 && !body),
      });
      if (
        !options.exactTotal &&
        positive.size === 0 &&
        heap.values.length === limit
      )
        break;
    }
  }
  const ranked = heap.values.sort((a, b) => b.score - a.score || a.doc - b.doc),
    display = performance.now(),
    resultRequests = reader.stats.requests,
    resultBytes = reader.stats.bytes,
    resultSharedGets = reader.stats.sharedGets,
    resultMemoryHits = reader.stats.memoryHits,
    results = packages
      ? await Promise.all(
          ranked.map(async (h) =>
            packageResult(
              packageHits.get(h.doc) ?? (await packages.load(h.doc)),
              h,
              positiveIds,
              options,
            ),
          ),
        )
      : await renderResults(root, reader, ranked, options, ast);
  reader.stats.metadataMs = performance.now() - display;
  reader.stats.resultRequests = reader.stats.requests - resultRequests;
  reader.stats.resultBytes = reader.stats.bytes - resultBytes;
  reader.stats.resultSharedGets = reader.stats.sharedGets - resultSharedGets;
  reader.stats.resultMemoryHits = reader.stats.memoryHits - resultMemoryHits;
  return {
    results,
    ...(options.exactTotal ? { total } : {}),
    generation: root.generation,
    diagnostics: {
      ...reader.stats,
      executor: plan.kind,
      pair: undefined,
      plan,
      wallMs: performance.now() - started,
      retainedPageBytes: reader.memory.pages.bytes,
      retainedDecodedBytes: reader.memory.decoded.bytes,
    },
  };
}
