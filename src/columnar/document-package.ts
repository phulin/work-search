import { concat, u32, view, pack, unpack, lower } from "./format.js";
import { scanText } from "./construction/text.js";
import { encodeTextChunks, TextChunks } from "./text-chunks.js";
import { encodeSpan, decodeSpan, packedAt } from "./compact-integers.js";
import {
  analyzeDocument,
  resolveDocument,
  type AnalyzedDocument,
  type NumericDocument,
} from "./construction/analyzed-document.js";

const MAGIC = 0x34504443;
export const VERIFICATION_CHUNK_BYTES = 32768;
// A complete numeric record can be a better first read than several small
// dependent ranges. This transfer threshold is independent of chunk geometry.
export const VERIFICATION_PREFIX_BYTES = 1024 * 1024;
export type DocumentRead = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;
type Observe = (
  kind: "decoded" | "inflated" | "tokens" | "positions",
  section: number,
  bytes: number,
) => void;
async function gzip(value: unknown) {
  return new Uint8Array(
    await new Response(
      new Response(JSON.stringify(value)).body!.pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}
export interface PackageDocument {
  doc: number;
  id: string;
  title?: string;
  metadata?: unknown;
  body: string;
}
/** The prefix address is bundled. Small documents contain complete numeric
 * verification; long documents expose a bounded-depth term-block directory.
 * Display and passage bytes never belong to a verification read. */
export function documentPrefix(
  bytes: Uint8Array,
  completeBytes = VERIFICATION_PREFIX_BYTES,
) {
  const v = view(bytes);
  if (bytes.length < 64 || v.getUint32(0, true) !== MAGIC)
    throw Error("Invalid document verification");
  return v.getUint32(16, true) <= completeBytes
    ? v.getUint32(16, true)
    : v.getUint32(20, true);
}
export function encodeDocumentParts(
  input: {
    doc: number;
    body: ArrayLike<number>;
    title: ArrayLike<number>;
    display: Uint8Array;
    directory: Uint8Array;
    text: Uint8Array;
  },
  chunkBytes = VERIFICATION_CHUNK_BYTES,
) {
  if (![16384, 32768, 65536].includes(chunkBytes))
    throw Error("Invalid verification chunk size");
  const rows = new Map<number, [number[], number[]]>();
  for (const [f, tokens] of [input.body, input.title].entries())
    for (let p = 0; p < tokens.length; p++) {
      const id = tokens[p];
      if (!Number.isInteger(id) || id < 0 || id > 0xffffffff)
        throw Error("Invalid document token");
      let row = rows.get(id);
      if (!row) rows.set(id, (row = [[], []]));
      row[f].push(p);
    }
  const ids = [...rows.keys()].sort((a, b) => a - b),
    blocks: Uint8Array[] = [],
    positions: Uint8Array[] = [],
    header = new Uint8Array(64 + Math.ceil(ids.length / 128) * 16),
    v = view(header);
  let posBytes = 0,
    at = header.length;
  for (let first = 0; first < ids.length; first += 128) {
    const names = ids.slice(first, first + 128),
      offsets = [posBytes];
    for (const id of names)
      for (const field of rows.get(id)!) {
        const raw = encodeSpan(field, true);
        positions.push(raw);
        posBytes += raw.length;
        offsets.push(posBytes);
      }
    const columns = [
        pack(names, true),
        pack(names.map((id) => rows.get(id)![0].length)),
        pack(names.map((id) => rows.get(id)![1].length)),
        pack(offsets),
      ],
      block = concat([u32(columns.map((c) => c.length)), ...columns]),
      p = 64 + (first / 128) * 16;
    [names.at(-1)!, at, block.length, names.length].forEach((n, j) =>
      v.setUint32(p + j * 4, n, true),
    );
    blocks.push(block);
    at += block.length;
  }
  const positionBase = at,
    verificationEnd = at + posBytes,
    displayAt = verificationEnd,
    directoryAt = displayAt + input.display.length,
    textAt = directoryAt + input.directory.length;
  [
    MAGIC,
    input.doc,
    input.body.length,
    input.title.length,
    verificationEnd,
    header.length,
    blocks.length,
    positionBase,
    displayAt,
    input.display.length,
    directoryAt,
    input.directory.length,
    textAt,
    input.text.length,
    chunkBytes,
    textAt + input.text.length,
  ].forEach((n, i) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
      throw Error("Oversized document record");
    v.setUint32(i * 4, n, true);
  });
  return concat([
    header,
    ...blocks,
    ...positions,
    input.display,
    input.directory,
    input.text,
  ]);
}
export async function encodeDocumentPackage(
  document: PackageDocument,
  ids: Map<string, number>,
  analysis?: import("../query/analysis.js").Analysis,
) {
  const analyzed = analyzeDocument(document, analysis);
  return encodeAnalyzedDocumentPackage(
    analyzed,
    resolveDocument(analyzed, ids),
  );
}
export async function encodeAnalyzedDocumentPackage(
  analyzed: AnalyzedDocument,
  numeric: NumericDocument,
) {
  const document = analyzed.document,
    text = await encodeTextChunks(analyzed.text, Array.from(analyzed.starts));
  return encodeDocumentParts({
    doc: document.doc,
    body: numeric.body,
    title: numeric.title,
    display: await gzip({
      id: document.id,
      title: document.title,
      metadata: document.metadata,
    }),
    directory: text.directory,
    text: text.data,
  });
}
interface TermBlock {
  ids: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  offsets: Uint8Array;
}
export class DocumentPackage {
  readonly data: DataView;
  readonly bodyLength: number;
  readonly titleLength: number;
  private blocks = new Map<number, TermBlock>();
  private raw = new Map<string, Uint8Array>();
  private expanded = new Map<string, Uint32Array>();
  private stats?: { ids: Uint32Array; body: Uint32Array; title: Uint32Array };
  private record?: Promise<any>;
  constructor(
    readonly bytes: Uint8Array,
    readonly doc: number,
    readonly observe?: Observe,
    private readonly load?: DocumentRead,
  ) {
    this.data = view(bytes);
    if (
      bytes.length < 64 ||
      this.data.getUint32(0, true) !== MAGIC ||
      this.data.getUint32(4, true) !== doc
    )
      throw Error("Invalid document verification");
    this.bodyLength = this.data.getUint32(8, true);
    this.titleLength = this.data.getUint32(12, true);
    const root = this.data.getUint32(20, true),
      end = this.data.getUint32(16, true),
      base = this.data.getUint32(28, true),
      total = this.data.getUint32(60, true);
    if (
      root !== 64 + this.data.getUint32(24, true) * 16 ||
      root > bytes.length ||
      base < root ||
      end < base ||
      end !== this.data.getUint32(32, true) ||
      total < end ||
      (!load && total !== bytes.length) ||
      ![16384, 32768, 65536].includes(this.data.getUint32(56, true))
    )
      throw Error("Invalid document section directory");
    let next = root,
      last = -1;
    for (let i = 0; i < this.data.getUint32(24, true); i++) {
      const p = 64 + i * 16,
        id = this.data.getUint32(p, true),
        at = this.data.getUint32(p + 4, true),
        n = this.data.getUint32(p + 8, true),
        count = this.data.getUint32(p + 12, true);
      if (
        id <= last ||
        at !== next ||
        n < 16 ||
        at + n > base ||
        count < 1 ||
        count > 128
      )
        throw Error("Invalid document term directory");
      next = at + n;
      last = id;
    }
    if (next !== base) throw Error("Invalid document frequency extent");
    next = end;
    for (const p of [32, 40, 48]) {
      const at = this.data.getUint32(p, true),
        n = this.data.getUint32(p + 4, true);
      if (at !== next || at + n > total)
        throw Error("Invalid document presentation section");
      next = at + n;
    }
    if (next !== total) throw Error("Trailing document bytes");
  }
  get rawBytes() {
    return (
      this.bytes.length +
      [...this.raw.values()].reduce((n, b) => n + b.length, 0)
    );
  }
  get numericBytes() {
    return (
      [...this.blocks.values()].reduce(
        (n, b) => n + b.ids.byteLength + b.body.byteLength + b.title.byteLength,
        0,
      ) +
      [...this.expanded.values()].reduce((n, a) => n + a.byteLength, 0) +
      (this.stats ? this.stats.ids.byteLength * 3 : 0)
    );
  }
  retain() {
    const copy = new DocumentPackage(
      this.bytes,
      this.doc,
      this.observe,
      this.load,
    );
    copy.raw = new Map(this.raw);
    return copy;
  }
  private available(at: number, n: number) {
    if (at + n <= this.bytes.length) return this.bytes.subarray(at, at + n);
    const exact = this.raw.get(`${at}:${n}`);
    if (exact) return exact;
    for (const [key, bytes] of this.raw) {
      const start = Number(key.slice(0, key.indexOf(":")));
      if (start <= at && start + bytes.length >= at + n)
        return bytes.subarray(at - start, at - start + n);
    }
  }
  private async read(at: number, n: number) {
    if (!n) return new Uint8Array();
    const old = this.available(at, n);
    if (old) return old;
    if (!this.load || at < 0 || at + n > this.data.getUint32(60, true))
      throw Error("Document range unavailable");
    const data = await this.load(at, n);
    if (data.length !== n) throw Error("Truncated document range");
    this.raw.set(`${at}:${n}`, data);
    return data;
  }
  private decodeBlock(i: number) {
    const cached = this.blocks.get(i);
    if (cached) return cached;
    const p = 64 + i * 16,
      n = this.data.getUint32(p + 8, true),
      raw = this.available(this.data.getUint32(p + 4, true), n);
    if (!raw) throw Error("Document term block not prepared");
    const v = view(raw),
      arrays: Uint8Array[] = [];
    let at = 16;
    for (let j = 0; j < 4; j++) {
      const size = v.getUint32(j * 4, true);
      if (at + size > raw.length) throw Error("Invalid document term columns");
      arrays.push(raw.subarray(at, at + size));
      at += size;
    }
    const [ids, body, title] = arrays.slice(0, 3).map((a) => unpack(a)),
      count = this.data.getUint32(p + 12, true);
    if (
      at !== raw.length ||
      ids.length !== count ||
      body.length !== count ||
      title.length !== count ||
      ids[count - 1] !== this.data.getUint32(p, true) ||
      ids.some(
        (id, j) =>
          id <= (j ? ids[j - 1] : i ? this.data.getUint32(p - 16, true) : -1),
      ) ||
      body.some(
        (b, j) =>
          (!b && !title[j]) ||
          b > this.bodyLength ||
          title[j] > this.titleLength,
      ) ||
      view(arrays[3]).getUint32(0, true) !== count * 2 + 1
    )
      throw Error("Invalid document term columns");
    const block = { ids, body, title, offsets: arrays[3] };
    this.blocks.set(i, block);
    this.stats = undefined;
    this.observe?.("decoded", i, ids.byteLength * 3);
    return block;
  }
  private find(id: number) {
    let lo = 0,
      hi = this.data.getUint32(24, true);
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.data.getUint32(64 + m * 16, true) < id) lo = m + 1;
      else hi = m;
    }
    return lo === this.data.getUint32(24, true) ? -1 : lo;
  }
  /** Frequency blocks and position chunks are fetched together within each
   * known level, never one network request per query term occurrence. */
  async prepare(wanted?: Set<number>) {
    const indices = wanted
      ? [
          ...new Set(
            [...wanted].map((id) => this.find(id)).filter((i) => i >= 0),
          ),
        ]
      : Array.from({ length: this.data.getUint32(24, true) }, (_, i) => i);
    await Promise.all(
      indices.map((i) =>
        this.read(
          this.data.getUint32(68 + i * 16, true),
          this.data.getUint32(72 + i * 16, true),
        ),
      ),
    );
    for (const i of indices) this.decodeBlock(i);
    const chunks = new Map<number, number>(),
      base = this.data.getUint32(28, true),
      end = this.data.getUint32(16, true),
      size = this.data.getUint32(56, true);
    for (const i of indices) {
      const b = this.decodeBlock(i);
      for (let row = 0; row < b.ids.length; row++)
        if (!wanted || wanted.has(b.ids[row]))
          for (let f = 0; f < 2; f++) {
            const from = base + packedAt(b.offsets, row * 2 + f),
              to = base + packedAt(b.offsets, row * 2 + f + 1);
            if (from > to || to > end)
              throw Error("Invalid document position span");
            if (from === to) continue;
            for (
              let at = base + Math.floor((from - base) / size) * size;
              at < to;
              at += size
            )
              chunks.set(at, Math.min(size, end - at));
          }
    }
    await Promise.all([...chunks].map(([at, n]) => this.read(at, n)));
  }
  frequencies() {
    if (this.stats) return this.stats;
    // Full-buffer construction/offline callers may read all terms synchronously.
    if (!this.load)
      for (let i = 0; i < this.data.getUint32(24, true); i++)
        this.decodeBlock(i);
    const blocks = [...this.blocks]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => b),
      count = blocks.reduce((n, b) => n + b.ids.length, 0),
      ids = new Uint32Array(count),
      body = new Uint32Array(count),
      title = new Uint32Array(count);
    let at = 0;
    for (const b of blocks) {
      ids.set(b.ids, at);
      body.set(b.body, at);
      title.set(b.title, at);
      at += b.ids.length;
    }
    return (this.stats = { ids, body, title });
  }
  positions(wanted: Set<number>, field: number) {
    if (field !== 0 && field !== 1) throw Error("Invalid token field");
    const result = new Map<number, Uint32Array>(),
      base = this.data.getUint32(28, true),
      size = this.data.getUint32(56, true),
      end = this.data.getUint32(16, true);
    for (const id of wanted) {
      const i = this.find(id);
      if (i < 0) continue;
      const b = this.decodeBlock(i),
        row = lower(b.ids, id);
      if (b.ids[row] !== id) continue;
      const count = (field ? b.title : b.body)[row];
      if (!count) continue;
      const key = `${id}:${field}`;
      let values = this.expanded.get(key);
      if (!values) {
        const from = base + packedAt(b.offsets, row * 2 + field),
          to = base + packedAt(b.offsets, row * 2 + field + 1);
        if (from > to || to > end)
          throw Error("Invalid document position span");
        let raw = this.available(from, to - from);
        if (!raw) {
          const parts: Uint8Array[] = [];
          for (
            let at = base + Math.floor((from - base) / size) * size;
            at < to;
            at += size
          ) {
            const chunk = this.available(at, Math.min(size, end - at));
            if (!chunk) throw Error("Document position chunk not prepared");
            parts.push(
              chunk.subarray(
                Math.max(0, from - at),
                Math.min(chunk.length, to - at),
              ),
            );
          }
          raw = parts.length === 1 ? parts[0] : concat(parts);
        }
        const decoded = decodeSpan(raw, 0, count, true);
        if (
          decoded.next !== raw.length ||
          decoded.values.at(-1)! >= (field ? this.titleLength : this.bodyLength)
        )
          throw Error("Invalid document positions");
        values = decoded.values;
        this.expanded.set(key, values);
        this.observe?.("positions", id * 2 + field, values.byteLength);
      }
      result.set(id, values);
    }
    return result;
  }
  /** Construction-only reconstruction; serving verification never scans tokens. */
  tokens(field: number) {
    const f = this.frequencies(),
      output = new Uint32Array(field ? this.titleLength : this.bodyLength);
    let count = 0;
    for (const [id, positions] of this.positions(new Set(f.ids), field))
      for (const p of positions) {
        output[p] = id;
        count++;
      }
    if (count !== output.length) throw Error("Document token count mismatch");
    return output;
  }
  async display() {
    return (this.record ??= (async () => {
      const data = await this.read(
          this.data.getUint32(32, true),
          this.data.getUint32(36, true),
        ),
        raw = await new Response(
          new Response(data as BodyInit).body!.pipeThrough(
            new DecompressionStream("gzip"),
          ),
        ).arrayBuffer();
      this.observe?.("inflated", -1, raw.byteLength);
      return JSON.parse(new TextDecoder().decode(raw));
    })());
  }
  /** Only winners reach this path. A small presentation tail is cheaper as one
   * range than separate metadata/directory/passage GETs. Large tails retain
   * independently addressed passages and the existing excerpt selection. */
  async preparePresentation() {
    const at = this.data.getUint32(32, true),
      bytes = this.data.getUint32(60, true) - at;
    if (bytes <= 65536) await this.read(at, bytes);
  }
  async snippet(wanted: Set<number>, first?: number, titleOnly = false) {
    if (titleOnly)
      return String((await this.display()).title ?? "").slice(0, 400);
    if (first === undefined) {
      await this.prepare(wanted);
      for (const p of this.positions(wanted, 0).values())
        if (p.length) first = Math.min(first ?? Infinity, p[0]);
    }
    const directory = await this.read(
        this.data.getUint32(40, true),
        this.data.getUint32(44, true),
      ),
      base = this.data.getUint32(48, true);
    return new TextChunks(
      directory,
      (at, n) => this.read(base + at, n),
      (chunk, n) => this.observe?.("inflated", 2000000 + chunk, n),
      this.data.getUint32(52, true),
    ).snippet(first);
  }
}
