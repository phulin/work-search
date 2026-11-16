import { BLOCK, unpackColumn, view, type Root, type Ref } from "./format.js";
import { contribution, scoreParameters } from "./scoring.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { Options } from "./search.js";
export interface FrequencyPart {
  term: DirectoryTerm;
  ref: Ref;
  required?: boolean;
}
function valueAt(v: DataView, offset: number, width: number, row: number) {
  if (offset < 0 || !width) return 0;
  const bit = row * width,
    at = offset + 12 + (bit >>> 5) * 4,
    shift = bit & 31;
  let value = v.getUint32(at, true) >>> shift;
  if (shift + width > 32) value |= v.getUint32(at + 4, true) << (32 - shift);
  return (value & (width === 32 ? 0xffffffff : 2 ** width - 1)) >>> 0;
}

/** Score sorted, conservative candidates from complete numeric packets. Only
 * matching rows' frequencies and lengths are accessed; document text is absent. */
export async function scoreCompleteCandidates(
  matches: Uint32Array,
  parts: FrequencyPart[],
  root: Root,
  reader: Reader,
  options: Pick<Options, "field" | "titleBoost">,
  present?: Uint16Array,
  titleOnly?: Uint8Array,
  workspaceBytes = 0,
) {
  const count = matches.length,
    scores = new Float64Array(count),
    field = options.field ?? "all",
    boost = options.titleBoost ?? 2,
    before = reader.stats.requests + reader.stats.sharedGets,
    raw = count ? await reader.completePackets(parts.map((p) => p.ref)) : [];
  if (count) reader.stats.scoreFetchWaves++;
  if (reader.stats.requests + reader.stats.sharedGets > before)
    reader.stats.scoreIOWaves++;
  reader.stats.peakActiveBufferBytes = Math.max(
    reader.stats.peakActiveBufferBytes,
    workspaceBytes +
      matches.byteLength +
      scores.byteLength +
      (present?.byteLength ?? 0) +
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
        if (
          parts[j].required &&
          ((field !== "title" && body) || (field !== "body" && title))
        )
          present![wanted]++;
        if (titleOnly && field !== "title" && body) titleOnly[wanted] = 0;
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

  return scores;
}
