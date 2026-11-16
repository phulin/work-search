import type { Node } from "../query/parser.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { Options, PhraseExecution } from "./search.js";
import type { CandidatePackages } from "./packet-execution.js";
import { packageResult } from "./packet-execution.js";
import { filterDocuments } from "./document-filter.js";
import { BLOCK, unpackColumn, view, type Root } from "./format.js";
import { contribution, scoreParameters } from "./scoring.js";
import { Heap } from "./top-k.js";

function valueAt(v: DataView, offset: number, width: number, row: number) {
  if (offset < 0 || !width) return 0;
  const bit = row * width,
    at = offset + 12 + (bit >>> 5) * 4,
    shift = bit & 31;
  let value = v.getUint32(at, true) >>> shift;
  if (shift + width > 32) value |= v.getUint32(at + 4, true) << (32 - shift);
  return (value & (width === 32 ? 0xffffffff : 2 ** width - 1)) >>> 0;
}

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
  if (ast.kind !== "phrase" || !packages || !exact.covered(ast.terms)) return;
  const plan = exact.plans.find(
    (p) => p.words.join("\0") === ast.terms.join("\0"),
  );
  if (!plan || plan.membershipOnly) return;
  const parts = [...new Set(ast.terms)].flatMap((word) => {
      const term = terms.get(word)!;
      return [term.frequencies, ...(term.frequencyParts ?? [])].map((ref) => ({
        term,
        ref,
      }));
    }),
    frequencyBytes = parts.reduce((n, p) => n + p.ref[2], 0),
    field = options.field ?? "all",
    bound =
      field === "body"
        ? plan.pair.bodyDf
        : field === "title"
          ? plan.pair.titleDf
          : plan.pair.df,
    physicalBytes = reader.packetFootprint(parts.map((p) => p.ref));
  // These constrain transfer and active buffers, never the answer. Larger
  // phrases retain the streamed block executor and its exact stopping proofs.
  if (
    !parts.every((p) => p.ref[2]) ||
    frequencyBytes > 16 * 1048576 ||
    physicalBytes > 20 * 1048576 ||
    plan.bytes > 4 * 1048576 ||
    bound > 131072
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
    boost = options.titleBoost ?? 2;
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
      const body = exact.evidence(ast.terms, doc, 0)!;
      docs[count] = doc;
      first[count] = body.length ? body[0] : 0xffffffff;
      titleOnly[count] = Number(field === "title" || !body.length);
      count++;
    }
    exact.release(lo);
  }
  const matches = docs.subarray(0, count),
    scores = new Float64Array(count),
    refs = parts.map((p) => p.ref),
    before = reader.stats.requests + reader.stats.sharedGets,
    raw = count ? await reader.completePackets(refs) : [];
  if (count) reader.stats.scoreFetchWaves++;
  if (reader.stats.requests + reader.stats.sharedGets > before)
    reader.stats.scoreIOWaves++;
  reader.stats.peakActiveBufferBytes = Math.max(
    reader.stats.peakActiveBufferBytes,
    docs.byteLength +
      first.byteLength +
      titleOnly.byteLength +
      scores.byteLength +
      raw.reduce((n, r) => n + r.length, 0),
  );
  const postingDocs = new Uint32Array(BLOCK),
    columnAt = new Int32Array(4),
    columnWidth = new Uint8Array(4);
  for (let j = 0; j < raw.length; j++) {
    const { term, ref } = parts[j],
      data = raw[j],
      v = view(data),
      parameters = scoreParameters(term.df, root);
    let wanted = 0;
    const consume = (
      bytes: Uint8Array,
      at: number,
      expected?: { first: number; last: number; count: number },
    ) => {
      const v = view(bytes);
      if (bytes.length < 36 || v.getUint32(0, true) !== 0x34534343)
        throw Error("Invalid scoring block");
      const docsLength = v.getUint32(4, true),
        n = v.getUint32(24, true);
      if (!n || n > BLOCK || unpackColumn(v, 24, docsLength, postingDocs) !== n)
        throw Error("Invalid scoring documents");
      let cursor = 24 + docsLength;
      for (let c = 0; c < 4; c++) {
        const length = v.getUint32(8 + c * 4, true);
        columnAt[c] = length ? cursor : -1;
        columnWidth[c] = 0;
        if (length) {
          if (
            length < 12 ||
            cursor + length > bytes.length ||
            v.getUint32(cursor, true) !== n ||
            v.getUint8(cursor + 9) !== 0
          )
            throw Error("Invalid scoring column");
          const width = v.getUint8(cursor + 8);
          if (width > 32 || length !== 12 + Math.ceil((n * width) / 32) * 4)
            throw Error("Invalid scoring width");
          columnWidth[c] = width;
        }
        cursor += length;
      }
      if (cursor !== bytes.length) throw Error("Invalid scoring columns");
      if (
        expected &&
        (n !== expected.count ||
          postingDocs[0] !== expected.first ||
          postingDocs[n - 1] !== expected.last)
      )
        throw Error("Complete score block identity mismatch");
      reader.stats.scorePostingsDecoded += n;
      reader.stats.postings += n;
      reader.observeDecoded([ref[0], ref[1] + at, bytes.length], bytes.length);
      for (let row = 0; row < n; row++) {
        const doc = postingDocs[row];
        if (row && doc <= postingDocs[row - 1])
          throw Error("Unsorted scoring documents");
        while (wanted < count && matches[wanted] < doc) wanted++;
        if (wanted >= count || matches[wanted] !== doc) continue;
        const body = valueAt(v, columnAt[0], columnWidth[0], row),
          title = valueAt(v, columnAt[1], columnWidth[1], row),
          bodyLength = body ? valueAt(v, columnAt[2], columnWidth[2], row) : 0,
          titleLength = title
            ? valueAt(v, columnAt[3], columnWidth[3], row)
            : 0;
        reader.stats.scoreFrequencyIntegers +=
          2 + Number(!!body) + Number(!!title);
        if (body > bodyLength || title > titleLength)
          throw Error("Invalid field length");
        scores[wanted] +=
          (field !== "title"
            ? contribution(body, bodyLength, parameters.avgBody, parameters.idf)
            : 0) +
          (field !== "body"
            ? boost *
              contribution(
                title,
                titleLength,
                parameters.avgTitle,
                parameters.idf,
              )
            : 0);
      }
    };
    if (v.getUint32(0, true) !== 0x34465443) {
      reader.stats.scoreBlocksFetched++;
      reader.stats.scoreBlockVisits++;
      consume(data, 0);
      continue;
    }
    if (
      data.length < 24 ||
      v.getUint32(4, true) !== term.id ||
      24 + v.getUint32(12, true) * 48 > data.length ||
      v.getUint32(16, true) !== data.length
    )
      throw Error("Invalid complete frequency packet");
    const blocks = v.getUint32(12, true),
      header = 24 + blocks * 48;
    reader.stats.scoreBlocksFetched += blocks;
    reader.stats.scoreBlockVisits += blocks;
    let rows = 0,
      previous = -1,
      end = header;
    for (let b = 0; b < blocks; b++) {
      const p = 24 + b * 48,
        first = v.getUint32(p, true),
        last = v.getUint32(p + 4, true),
        n = v.getUint32(p + 8, true),
        at = v.getUint32(p + 12, true),
        bytes = v.getUint32(p + 16, true);
      if (
        !n ||
        first <= previous ||
        last < first ||
        at !== end ||
        at + bytes > data.length
      )
        throw Error("Invalid complete score directory");
      previous = last;
      end = at + bytes;
      rows += n;
      while (wanted < count && matches[wanted] < first) wanted++;
      if (wanted < count && matches[wanted] <= last)
        consume(data.subarray(at, end), at, { first, last, count: n });
    }
    if (end !== data.length || rows !== v.getUint32(8, true))
      throw Error("Incomplete frequency packet");
  }
  const heap = new Heap(options.limit ?? 20);
  let total = 0;
  for (let i = 0; i < count; i++) {
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
