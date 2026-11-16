import { concat, lower, view, u32 } from "./format.js";
import {
  encodePairColumns,
  PairPacket,
  pairPacketByteBound,
  type PairColumnRow,
} from "./pair-packet.js";
const MAGIC = 0x31525043;
export interface PairPositionChunk {
  first: number;
  last: number;
  object: number;
  offset: number;
  length: number;
}
/** Separate from membership: fixed chunk routes lead directly to bounded
 * positional/context records, including multiple chunks for a single long row. */
export function encodePairPositionDirectory(
  a: number,
  b: number,
  generation: string,
  chunks: PairPositionChunk[],
) {
  if (!/^[a-f0-9]{64}$/.test(generation))
    throw Error("Invalid pair position generation");
  const head = new Uint8Array(48),
    v = view(head);
  [MAGIC, a, b, chunks.length].forEach((n, i) => v.setUint32(i * 4, n, true));
  for (let i = 0; i < 32; i++)
    head[16 + i] = parseInt(generation.slice(i * 2, i * 2 + 2), 16);
  return concat([
    head,
    u32(chunks.flatMap((c) => [c.first, c.last, c.object, c.offset, c.length])),
  ]);
}
export class PairPositionDirectory {
  readonly a: number;
  readonly b: number;
  readonly generation: string;
  readonly chunks: PairPositionChunk[] = [];
  constructor(readonly bytes: Uint8Array) {
    const v = view(bytes);
    if (
      bytes.length < 48 ||
      v.getUint32(0, true) !== MAGIC ||
      bytes.length !== 48 + v.getUint32(12, true) * 20
    )
      throw Error("Invalid pair position directory");
    this.a = v.getUint32(4, true);
    this.b = v.getUint32(8, true);
    this.generation = [...bytes.subarray(16, 48)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    for (let p = 48; p < bytes.length; p += 20) {
      const c = {
        first: v.getUint32(p, true),
        last: v.getUint32(p + 4, true),
        object: v.getUint32(p + 8, true),
        offset: v.getUint32(p + 12, true),
        length: v.getUint32(p + 16, true),
      };
      if (
        c.first > c.last ||
        c.first < (this.chunks.at(-1)?.last ?? -1) ||
        !c.length ||
        c.length > 65536 ||
        c.offset + c.length > 32 * 1048576
      )
        throw Error("Invalid pair position chunk");
      this.chunks.push(c);
    }
  }
  selected(docs: Uint32Array) {
    return this.chunks.filter((c) => docs[lower(docs, c.first)] <= c.last);
  }
  address(c: PairPositionChunk) {
    return `${this.generation}/positions-${c.object}.bin@${c.offset}`;
  }
}
export function isPairPositionDirectory(data: Uint8Array) {
  return data.length >= 4 && view(data).getUint32(0, true) === MAGIC;
}
export function* pairPositionChunks(
  a: number,
  b: number,
  rows: Iterable<PairColumnRow>,
  budget = 32768,
) {
  if (![16384, 32768, 65536].includes(budget))
    throw Error("Invalid pair chunk budget");
  let batch: PairColumnRow[] = [],
    occurrences = 0,
    last = -1;
  const encode = () => {
    const raw = encodePairColumns(a, b, batch);
    if (raw.length > budget) throw Error("Pair chunk exceeded budget");
    return { first: batch[0].doc, last: batch.at(-1)!.doc, data: raw };
  };
  const empty = () => ({
    positions: new Uint32Array(),
    previous: new Uint32Array(),
    next: new Uint32Array(),
  });
  function* pieces(row: PairColumnRow): Generator<PairColumnRow> {
    const step = Math.floor((budget - 256) / 64);
    if (row.body.positions.length + row.title.positions.length <= step) {
      yield row;
      return;
    }
    for (const field of [0, 1]) {
      const col = field ? row.title : row.body;
      for (let first = 0; first < col.positions.length; first += step) {
        const n = Math.min(step, col.positions.length - first),
          piece = {
            positions: Uint32Array.from(
              { length: n },
              (_, j) => col.positions[first + j],
            ),
            previous: Uint32Array.from(
              { length: n },
              (_, j) => col.previous[first + j],
            ),
            next: Uint32Array.from(
              { length: n },
              (_, j) => col.next[first + j],
            ),
          };
        yield {
          doc: row.doc,
          body: field ? empty() : piece,
          title: field ? piece : empty(),
        };
      }
    }
  }
  for (const row of rows) {
    if (row.doc <= last) throw Error("Pair rows must be sorted and unique");
    last = row.doc;
    for (const piece of pieces(row)) {
      const n = piece.body.positions.length + piece.title.positions.length;
      if (
        batch.length &&
        (batch.at(-1)!.doc === row.doc ||
          batch.length === 128 ||
          pairPacketByteBound(batch.length + 1, occurrences + n) > budget)
      ) {
        yield encode();
        batch = [];
        occurrences = 0;
      }
      batch.push(piece);
      occurrences += n;
    }
  }
  if (batch.length) yield encode();
}
export type PairEvidence = Pick<PairPacket, "docs" | "count" | "phrase">;
export async function readPairPositionChunks(
  directory: PairPositionDirectory,
  docs: Uint32Array,
  read: (key: string, n: number) => Promise<Uint8Array>,
  budget: number,
  observe?: ConstructorParameters<typeof PairPacket>[1],
): Promise<PairEvidence | undefined> {
  const selected = directory.selected(docs);
  if (selected.reduce((n, c) => n + c.length, 0) > budget) return;
  // Restart chunks can be much smaller than a useful GET. Join nearby chunks
  // without changing which rows are decoded. Bound both each transfer and its
  // overfetch; sparse candidates must not turn into a whole-list read.
  const groups: {
    chunks: PairPositionChunk[];
    length: number;
    useful: number;
  }[] = [];
  for (const c of selected) {
    const g = groups.at(-1),
      first = g?.chunks[0],
      end = first ? first.offset + g!.length : 0,
      span = first ? c.offset + c.length - first.offset : 0;
    if (
      g &&
      first!.object === c.object &&
      c.offset >= end &&
      c.offset - end <= 1024 &&
      span <= 262144 &&
      span <= 2 * (g.useful + c.length)
    ) {
      g.chunks.push(c);
      g.length = span;
      g.useful += c.length;
    } else groups.push({ chunks: [c], length: c.length, useful: c.length });
  }
  const packets = (
    await Promise.all(
      groups.map(async (g) => {
        const first = g.chunks[0],
          raw = await read(directory.address(first), g.length);
        if (raw.length !== g.length)
          throw Error("Truncated pair positional range");
        return g.chunks.map((c) => {
          const at = c.offset - first.offset,
            // Do not retain overfetched gaps through the decoded packet views.
            bytes =
              g.useful === g.length
                ? raw.subarray(at, at + c.length)
                : raw.slice(at, at + c.length),
            p = new PairPacket(bytes, observe);
          if (
            p.a !== directory.a ||
            p.b !== directory.b ||
            p.docs[0] !== c.first ||
            p.docs.at(-1) !== c.last
          )
            throw Error("Pair positional identity mismatch");
          return { chunk: c, packet: p };
        });
      }),
    )
  ).flat();
  function* forDoc(doc: number) {
    let lo = 0,
      hi = packets.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (packets[m].chunk.last < doc) lo = m + 1;
      else hi = m;
    }
    for (let i = lo; i < packets.length; i++) {
      const { chunk, packet } = packets[i];
      if (chunk.first > doc) break;
      const row = lower(packet.docs, doc);
      if (packet.docs[row] === doc) yield { packet, row };
    }
  }
  return {
    docs,
    count: (row, field) =>
      [...forDoc(docs[row])].reduce(
        (n, p) => n + p.packet.count(p.row, field),
        0,
      ),
    phrase: (row, field, words, at) => {
      const all: number[] = [];
      for (const p of forDoc(docs[row]))
        for (const start of p.packet.phrase(p.row, field, words, at).starts)
          all.push(start);
      all.sort((a, b) => a - b);
      return {
        starts: Uint32Array.from(all.filter((p, i) => !i || p !== all[i - 1])),
        certain: !all.length || (at <= 1 && words.length - at - 2 <= 1),
      };
    },
  };
}
