import { concat, lower, view } from "./format.js";
import {
  encodePairColumns,
  PairPacket,
  type PairColumnRow,
} from "./pair-packet.js";
import type { ExactPairRanges } from "./pair-ranges.js";
import type { Reader } from "./storage.js";

/** Stream complete context, retaining only candidate rows. Physical extents do
 * not have document fences: inspect chunk membership, never decode unrelated
 * positions. A split document may span chunks or GETs. */
export async function candidatePairContext(
  directory: ExactPairRanges,
  docs: Uint32Array,
  reader: Reader,
  retainedBudget: number,
) {
  const groups = directory.ranges.flatMap((r) =>
    Array.from({ length: Math.ceil(r.length / 262144) }, (_, i) => ({
      object: r.object,
      offset: r.offset + i * 262144,
      length: Math.min(262144, r.length - i * 262144),
    })),
  );
  const pending = new Map<number, Promise<Uint8Array>>(),
    rows: PairColumnRow[] = [];
  let carry = new Uint8Array(),
    retained = 0,
    last = -1;
  const observe = (_row: number, _field: number, n: number, bytes: number) => {
    reader.stats.positionIntegers += n;
    reader.stats.pairContextIntegers += 2 * n;
    reader.stats.decodedBytes += bytes;
  };
  function start(i: number) {
    if (i >= groups.length || pending.has(i)) return;
    const g = groups[i];
    reader.stats.pairPositionChunks++;
    reader.stats.pairPositionBytes += g.length;
    const p = reader.named(
      `${directory.generation}/positions-${g.object}.bin@${g.offset}`,
      g.length,
    );
    p.catch(() => {});
    pending.set(i, p);
  }
  try {
    for (let i = 0; i < groups.length; i++) {
      for (let j = i; j < i + 6; j++) start(j);
      const fetched = await pending.get(i)!;
      pending.delete(i);
      const raw = carry.length ? concat([carry, fetched]) : fetched;
      let at = 0;
      while (at + 24 <= raw.length) {
        const v = view(raw.subarray(at)),
          size =
            24 +
            v.getUint32(12, true) +
            v.getUint32(16, true) +
            v.getUint32(20, true);
        if (size < 24 || size > 65536)
          throw Error("Invalid pair context chunk");
        if (at + size > raw.length) break;
        const p = new PairPacket(raw.subarray(at, at + size), observe);
        if (p.a !== directory.a || p.b !== directory.b || p.docs[0] < last)
          throw Error("Candidate pair context identity mismatch");
        last = p.docs.at(-1)!;
        for (
          let row = 0, wanted = lower(docs, p.docs[0]);
          row < p.docs.length && wanted < docs.length;
          row++
        ) {
          const doc = p.docs[row];
          while (wanted < docs.length && docs[wanted] < doc) wanted++;
          if (docs[wanted] !== doc) continue;
          const body = p.occurrences(row, 0),
            title = p.occurrences(row, 1);
          retained +=
            12 * (body.positions.length + title.positions.length) + 32;
          // Optional evidence may be abandoned; the original candidate stream
          // remains authoritative and ordinary verification still follows.
          if (retained > retainedBudget) return;
          rows.push({ doc, body, title });
        }
        at += size;
      }
      carry = raw.slice(at);
      if (carry.length >= 65536) throw Error("Unbounded pair context carry");
    }
    if (carry.length) throw Error("Truncated pair context stream");
    if (!rows.length)
      return {
        docs: new Uint32Array(),
        count: () => 0,
        phrase: () => ({ starts: new Uint32Array(), certain: true }),
      };
    // Keep split rows as separate packets: their positions must all contribute
    // to evidence, without forcing a large single-row repack.
    const packets = rows.map(
        (r) => new PairPacket(encodePairColumns(directory.a, directory.b, [r])),
      ),
      ids = Uint32Array.from(rows, (r) => r.doc),
      unique = Uint32Array.from(new Set(ids));
    reader.stats.anchorBufferBytes += packets.reduce(
      (n, p) => n + p.bytes.length,
      0,
    );
    return {
      docs: unique,
      count: (row: number, field: number) => {
        const doc = unique[row];
        let n = 0;
        for (let i = lower(ids, doc); i < ids.length && ids[i] === doc; i++)
          n += packets[i].count(0, field);
        return n;
      },
      phrase: (row: number, field: number, words: number[], anchor: number) => {
        const doc = unique[row],
          all: number[] = [];
        let certain = true;
        for (let i = lower(ids, doc); i < ids.length && ids[i] === doc; i++) {
          const match = packets[i].phrase(0, field, words, anchor);
          certain &&= match.certain;
          for (const p of match.starts) all.push(p);
        }
        all.sort((a, b) => a - b);
        return {
          starts: Uint32Array.from(
            all.filter((p, i) => !i || p !== all[i - 1]),
          ),
          certain,
        };
      },
    };
  } finally {
    await Promise.allSettled(pending.values());
  }
}
