import { pack, concat, u32, view, type Root } from "../format.js";
import { CorpusSource } from "./source.js";
import { ingestAnalyzer } from "./ingest-analysis.js";
import {
  encodeRunBlock,
  decodeRunBlock,
  type RunCodec,
} from "./block-codec.js";
import { SummaryWriter } from "./term-summaries.js";

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export const jsonBytes = (value: unknown) =>
  encoder.encode(JSON.stringify(value));
export async function digest(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function generationFor(root: Root) {
  return digest(jsonBytes({ ...root, generation: undefined }));
}
export const VERIFY_OBJECTS = 256;
export interface Chunk {
  key: string;
  size: number;
  sha256: string;
  /** Logical decode block inside a larger immutable staging object. */
  offset?: number;
  objectBytes?: number;
  terms?: number;
  firstTerm?: { at: number; word: string };
  firstWord?: string;
  lastWord?: string;
  codec?: RunCodec;
  rawBytes?: number;
}
export interface Run {
  chunks: Chunk[];
  first: number;
  next: number;
  count: number;
  bodyTokens: number;
  titleTokens: number;
  summaries?: Chunk[];
  analysisWork?: {
    tokens: number;
    stemCalls: number;
    cacheHits: number;
    cacheBytes: number;
    maxCacheBytes: number;
  };
}
export class BuildStore {
  requests = 0;
  bytes = 0;
  codecEncodeMs = 0;
  codecDecodeMs = 0;
  decodedBytes = 0;
  continuationDecodeBytes = 0;
  constructor(readonly bucket: R2Bucket) {}
  async putNamed(
    generation: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<Chunk> {
    if (!/^[a-f0-9]{64}$/.test(generation) || !/^plan-\d+\.bin$/.test(name))
      throw Error("Invalid immutable package key");
    const sha256 = await digest(bytes),
      key = `${generation}/${name}`;
    this.requests++;
    this.bytes += bytes.length;
    const written = await this.bucket.put(
      key,
      bytes as ArrayBufferView<ArrayBuffer>,
      {
        sha256,
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: { generation, sha256 },
      },
    );
    if (!written) {
      this.requests++;
      const old = await this.bucket.head(key);
      if (
        old?.size !== bytes.length ||
        old.customMetadata?.sha256 !== sha256 ||
        old.customMetadata?.generation !== generation
      )
        throw Error("Immutable package already has different bytes");
    }
    return { key, size: bytes.length, sha256 };
  }
  async put(bytes: Uint8Array, name?: string): Promise<Chunk> {
    const sha256 = await digest(bytes),
      key = `${sha256}/${name ?? `stage-${sha256}.bin`}`;
    this.requests++;
    this.bytes += bytes.length;
    try {
      await this.bucket.put(key, bytes as ArrayBufferView<ArrayBuffer>, {
        sha256,
        customMetadata: { generation: sha256, sha256 },
      });
    } catch (error) {
      // Independent jobs may produce identical immutable bytes. If another
      // upload won the race, its validated object satisfies this write too.
      this.requests++;
      const existing = await this.bucket.head(key);
      if (
        existing?.size !== bytes.length ||
        existing.customMetadata?.sha256 !== sha256
      )
        throw error;
    }
    return { key, size: bytes.length, sha256 };
  }
  async get(chunk: Chunk) {
    this.requests++;
    const ranged = chunk.offset !== undefined;
    if (
      ranged &&
      (!Number.isSafeInteger(chunk.offset) ||
        chunk.offset! < 0 ||
        !Number.isSafeInteger(chunk.objectBytes) ||
        chunk.offset! + chunk.size > chunk.objectBytes!)
    )
      throw Error("Invalid construction block range");
    const object = await this.bucket.get(
      chunk.key,
      ranged
        ? { range: { offset: chunk.offset!, length: chunk.size } }
        : undefined,
    );
    if (
      !object ||
      object.customMetadata?.sha256 !==
        (ranged ? chunk.key.split("/")[0] : chunk.sha256) ||
      (ranged && object.size !== chunk.objectBytes)
    )
      throw Error("Missing or changed construction chunk");
    const bytes = new Uint8Array(await object.arrayBuffer());
    this.bytes += bytes.length;
    if (bytes.length !== chunk.size || (await digest(bytes)) !== chunk.sha256)
      throw Error("Construction chunk checksum mismatch");
    return bytes;
  }
  async putParts(parts: Uint8Array[]): Promise<Chunk[]> {
    if (!parts.length) return [];
    if (parts.length === 1) return [await this.put(parts[0])];
    const object = await this.put(concat(parts)),
      chunks: Chunk[] = [];
    let offset = 0;
    for (const bytes of parts) {
      chunks.push({
        key: object.key,
        offset,
        size: bytes.length,
        objectBytes: object.size,
        sha256: await digest(bytes),
      });
      offset += bytes.length;
    }
    return chunks;
  }
  /** Coalesce only requested contiguous blocks. Verify each block's digest;
   * do not inflate adjacent blocks merely because their bytes share a GET. */
  async getMany(chunks: Chunk[], maxBytes = 8 * 1048576) {
    const result: Uint8Array[] = [];
    for (let at = 0; at < chunks.length;) {
      const first = chunks[at];
      let end = at + 1,
        length = first.size;
      if (first.offset !== undefined)
        while (
          end < chunks.length &&
          chunks[end].key === first.key &&
          chunks[end].objectBytes === first.objectBytes &&
          chunks[end].offset === first.offset + length &&
          length + chunks[end].size <= maxBytes
        )
          length += chunks[end++].size;
      if (end === at + 1) result.push(await this.get(first));
      else {
        this.requests++;
        const object = await this.bucket.get(first.key, {
          range: { offset: first.offset!, length },
        });
        if (
          !object ||
          object.size !== first.objectBytes ||
          object.customMetadata?.sha256 !== first.key.split("/")[0]
        )
          throw Error("Missing coalesced construction object");
        const data = new Uint8Array(await object.arrayBuffer());
        this.bytes += data.length;
        if (data.length !== length)
          throw Error("Truncated coalesced construction object");
        let p = 0;
        for (let i = at; i < end; i++) {
          const raw = data.subarray(p, p + chunks[i].size);
          if ((await digest(raw)) !== chunks[i].sha256)
            throw Error("Construction chunk checksum mismatch");
          result.push(raw);
          p += raw.length;
        }
      }
      at = end;
    }
    return result;
  }
}
// Chunks contain whole records; a single unusually large positional row can
// exceed the target. Readers keep at most one chunk per input run.
export class RunWriter {
  chunks: Chunk[] = [];
  records: Uint8Array[] = [];
  bytes = 0;
  terms = 0;
  firstTerm?: Chunk["firstTerm"];
  firstWord?: string;
  lastWord?: string;
  private parts: {
    bytes: Uint8Array;
    index: number;
    descriptor: Pick<
      Chunk,
      "terms" | "firstTerm" | "firstWord" | "lastWord" | "codec" | "rawBytes"
    >;
  }[] = [];
  private packedBytes = 0;
  constructor(
    readonly store: BuildStore,
    readonly target = 2 * 1048576,
    public currentWord?: string,
    readonly containerBytes = 16 * 1048576,
    readonly codec: RunCodec = "raw",
  ) {}
  async append(record: Uint8Array) {
    if (this.bytes && this.bytes + record.length > this.target)
      await this.flushBlock();
    if (view(record).getUint32(4, true) === 1) {
      this.terms++;
      this.currentWord = termHeader(record).word;
      this.firstTerm ??= { at: this.bytes, word: this.currentWord };
    }
    if (this.currentWord === undefined)
      throw Error("Construction chunk lacks term context");
    this.firstWord ??= this.currentWord;
    this.lastWord = this.currentWord;
    this.records.push(record);
    this.bytes += record.length;
  }
  /** A merge copies a contiguous group of positional rows without allocating
   * a typed-array view and promise for every posting. Headers remain separate. */
  async appendRows(rows: Uint8Array) {
    if (this.bytes && this.bytes + rows.length > this.target)
      await this.flushBlock();
    if (this.currentWord === undefined) throw Error("Rows lack term context");
    this.firstWord ??= this.currentWord;
    this.lastWord = this.currentWord;
    // Own the queued span: a tiny view must not pin an old 2 MiB input block
    // after its cursor advances while other fan-in readers hold newer blocks.
    this.records.push(Uint8Array.from(rows));
    this.bytes += rows.length;
  }
  private async flushBlock() {
    if (!this.bytes) return;
    const raw = concat(this.records),
      start = performance.now(),
      bytes = await encodeRunBlock(raw, this.codec),
      descriptor = {
        terms: this.terms,
        firstTerm: this.firstTerm,
        firstWord: this.firstWord,
        lastWord: this.lastWord,
        codec: this.codec,
        rawBytes: raw.length,
      };
    this.store.codecEncodeMs += performance.now() - start;
    if (
      this.packedBytes &&
      this.packedBytes + bytes.length > this.containerBytes
    )
      await this.flushContainer();
    this.parts.push({ bytes, descriptor, index: this.chunks.length });
    this.chunks.push(undefined as unknown as Chunk);
    this.packedBytes += bytes.length;
    this.records = [];
    this.bytes = 0;
    this.terms = 0;
    this.firstTerm = undefined;
    this.firstWord = undefined;
    this.lastWord = undefined;
  }
  private async flushContainer() {
    const chunks = await this.store.putParts(this.parts.map((p) => p.bytes));
    this.parts.forEach((p, i) => {
      this.chunks[p.index] = { ...chunks[i], ...p.descriptor };
    });
    this.parts = [];
    this.packedBytes = 0;
  }
  async flush() {
    await this.flushBlock();
    await this.flushContainer();
  }
  async finish() {
    await this.flush();
  }
}
export function termRecord(word: string, df: number) {
  const bytes = encoder.encode(word);
  return concat([u32([12 + bytes.length, 1, df]), bytes]);
}
const emptyPositions = pack([], true);
export function rowRecord(
  doc: number,
  bl: number,
  tl: number,
  body: number[],
  title: number[],
) {
  const b = body.length ? pack(body, true) : emptyPositions,
    t = title.length ? pack(title, true) : emptyPositions,
    raw = new Uint8Array(28 + b.length + t.length),
    header = new Uint32Array(raw.buffer, 0, 7);
  header[0] = raw.length;
  header[1] = 2;
  header[2] = doc;
  header[3] = bl;
  header[4] = tl;
  header[5] = b.length;
  header[6] = t.length;
  raw.set(b, 28);
  raw.set(t, 28 + b.length);
  return raw;
}
export interface Cursor {
  chunk: number;
  at: number;
}
export class RunReader {
  cursor: Cursor;
  data?: Uint8Array;
  private window = new Map<number, Uint8Array>();
  constructor(
    readonly store: BuildStore,
    readonly chunks: Chunk[],
    cursor: Cursor = { chunk: 0, at: 0 },
  ) {
    this.cursor = { ...cursor };
  }
  async peek(): Promise<Uint8Array | undefined> {
    if (!this.data) {
      if (this.cursor.chunk >= this.chunks.length) return;
      const chunk = this.chunks[this.cursor.chunk];
      if (!this.window.has(this.cursor.chunk)) {
        let end = this.cursor.chunk + 1,
          bytes = chunk.rawBytes ?? chunk.size;
        if (chunk.codec && chunk.codec !== "raw")
          while (
            end < this.chunks.length &&
            bytes + (this.chunks[end].rawBytes ?? this.chunks[end].size) <=
              1048576 &&
            this.chunks[end].key === chunk.key
          )
            bytes += this.chunks[end++].rawBytes ?? this.chunks[end - 1].size;
        const raw = await this.store.getMany(
          this.chunks.slice(this.cursor.chunk, end),
          1048576,
        );
        raw.forEach((b, i) => this.window.set(this.cursor.chunk + i, b));
      }
      const raw = this.window.get(this.cursor.chunk)!;
      this.window.delete(this.cursor.chunk);
      const start = performance.now();
      this.data = await decodeRunBlock(
        raw,
        chunk.codec ?? "raw",
        chunk.rawBytes,
      );
      this.store.codecDecodeMs += performance.now() - start;
      this.store.decodedBytes += this.data.length;
      this.store.continuationDecodeBytes += this.cursor.at;
    }
    const { at } = this.cursor;
    if (at + 8 > this.data.length) throw Error("Truncated construction record");
    const length = view(this.data).getUint32(at, true);
    if (length < 8 || at + length > this.data.length)
      throw Error("Invalid construction record");
    return this.data.subarray(at, at + length);
  }
  consume(record: Uint8Array) {
    this.cursor.at += record.length;
    if (this.cursor.at === this.data!.length) {
      this.cursor.chunk++;
      this.cursor.at = 0;
      this.data = undefined;
    }
  }
  contiguousRows(limit: number) {
    if (!this.data) throw Error("Rows require a loaded input chunk");
    const start = this.cursor.at,
      v = view(this.data);
    let at = start,
      count = 0;
    while (at < this.data.length) {
      if (at + 8 > this.data.length) throw Error("Truncated construction row");
      const length = v.getUint32(at, true),
        kind = v.getUint32(at + 4, true);
      if (length < 8 || at + length > this.data.length)
        throw Error("Invalid construction row");
      if (kind === 1) break;
      if (kind !== 2 || length < 28) throw Error("Unknown construction row");
      if (count && at + length - start > limit) break;
      at += length;
      count++;
    }
    return { bytes: this.data.subarray(start, at), count };
  }
  async seekTerm(word: string) {
    let lo = 0,
      hi = this.chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1,
        last = this.chunks[mid].lastWord;
      if (last === undefined) throw Error("Run lacks lexical fences");
      if (last < word) lo = mid + 1;
      else hi = mid;
    }
    this.cursor = { chunk: lo, at: 0 };
    this.data = undefined;
    this.window.clear();
    for (;;) {
      const record = await this.peek();
      if (!record) return;
      if (
        view(record).getUint32(4, true) === 1 &&
        termHeader(record).word >= word
      )
        return;
      this.consume(record);
    }
  }
}
export function termHeader(record: Uint8Array) {
  const v = view(record);
  if (v.getUint32(4, true) !== 1 || record.length < 12)
    throw Error("Expected term header");
  return {
    word: decoder.decode(record.subarray(12)),
    df: v.getUint32(8, true),
  };
}
export async function ingest(
  source: CorpusSource,
  store: BuildStore,
  first: number,
  count: number,
  tokenBudget = 1048576,
  analysis?: import("../../query/analysis.js").Analysis,
  format?: {
    codec: RunCodec;
    blockBytes: number;
    containerBytes: number;
    summaries: boolean;
  },
): Promise<Run> {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 512
  )
    throw Error("Invalid ingest range");
  const part = source.part(first),
    analyzer = ingestAnalyzer(analysis),
    end = Math.min(first + count, part.first + part.count),
    rows = new Map<
      string,
      { records: Uint8Array[]; body: number; title: number }
    >(),
    started = performance.now();
  let batchFirst = first,
    pointers = await source.pointers(first, Math.min(128, end - first));
  let next = first,
    bodyTokens = 0,
    titleTokens = 0;
  await source.prefetch(pointers);
  for (; next < end; next++) {
    if (next >= batchFirst + pointers.view.byteLength / 32) {
      batchFirst = next;
      pointers = await source.pointers(next, Math.min(128, end - next));
      await source.prefetch(pointers);
    }
    const d = await source.document(next, pointers, next - batchFirst),
      postings = new Map<string, [number[], number[]]>();
    let bl = 0,
      tl = 0;
    for (const field of [0, 1]) {
      const count = analyzer.scan(
        field ? (d.title ?? "") : d.body,
        (word, position) => {
          let pair = postings.get(word);
          if (!pair) postings.set(word, (pair = [[], []]));
          pair[field].push(position);
        },
      );
      if (field) tl = count;
      else bl = count;
    }
    for (const [word, [b, t]] of postings) {
      let list = rows.get(word);
      // Copy new keys: regex substrings must not retain entire document strings.
      if (!list)
        rows.set(
          decoder.decode(encoder.encode(word)),
          (list = { records: [], body: 0, title: 0 }),
        );
      list.records.push(rowRecord(next, bl, tl, b, t));
      list.body += b.length;
      list.title += t.length;
    }
    bodyTokens += bl;
    titleTokens += tl;
    if (
      bodyTokens + titleTokens >= tokenBudget ||
      performance.now() - started > 15000
    ) {
      next++;
      break;
    }
  }
  const writer = new RunWriter(
      store,
      format?.blockBytes,
      undefined,
      format?.containerBytes,
      format?.codec,
    ),
    summaries = format?.summaries ? new SummaryWriter(store) : undefined;
  for (const word of [...rows.keys()].sort()) {
    const list = rows.get(word)!;
    if (summaries)
      await summaries.append({
        word,
        df: list.records.length,
        body: list.body,
        title: list.title,
      });
    await writer.append(termRecord(word, list.records.length));
    for (const row of list.records) await writer.append(row);
    rows.delete(word);
  }
  await writer.flush();
  return {
    chunks: writer.chunks,
    first,
    next,
    count: next - first,
    bodyTokens,
    titleTokens,
    analysisWork: { ...analyzer.stats },
    ...(summaries ? { summaries: await summaries.finish() } : {}),
  };
}
export interface MergeState {
  cursors: Cursor[];
  word?: string;
  sources?: number[];
  source?: number;
  remaining?: number;
  done?: boolean;
}
/** Input ranges are consecutive and disjoint: equal-term rows concatenate in
 * document order. A common term can continue across any number of requests. */
export async function merge(
  store: BuildStore,
  runs: Run[],
  state?: MergeState,
  byteBudget = 8 * 1048576,
  range?: { firstWord?: string; endWord?: string },
  format?: { codec: RunCodec; blockBytes: number; containerBytes: number },
) {
  if (
    runs.length < 2 ||
    runs.length > 16 ||
    runs.some((r, i) => i && runs[i - 1].next !== r.first)
  )
    throw Error("Merge requires 2–16 consecutive document ranges");
  const starting = !state;
  state = state
    ? structuredClone(state)
    : { cursors: runs.map(() => ({ chunk: 0, at: 0 })) };
  if (state.cursors.length !== runs.length)
    throw Error("Invalid merge cursors");
  const readers = runs.map(
      (r, i) => new RunReader(store, r.chunks, state!.cursors[i]),
    ),
    writer = new RunWriter(
      store,
      format?.blockBytes ?? 2 * 1048576,
      state.word,
      format?.containerBytes,
      format?.codec,
    ),
    started = performance.now();
  if (starting && range?.firstWord)
    for (const reader of readers) await reader.seekTerm(range.firstWord);
  let emitted = 0;
  while (emitted < byteBudget && performance.now() - started < 45000) {
    if (state.word === undefined) {
      const headers: ({ word: string; df: number } | undefined)[] = [];
      // Consume each body inside the promise; four concurrent reads stay below
      // the Worker connection limit and retain only one chunk per input run.
      for (let at = 0; at < readers.length; at += 4)
        headers.push(
          ...(await Promise.all(
            readers.slice(at, at + 4).map(async (reader) => {
              const row = await reader.peek();
              return row ? termHeader(row) : undefined;
            }),
          )),
        );
      const words = headers.flatMap((h) => (h ? [h.word] : []));
      if (!words.length) {
        state.done = true;
        break;
      }
      state.word = words.reduce((a, b) => (a < b ? a : b));
      if (range?.endWord && state.word >= range.endWord) {
        state.word = undefined;
        state.done = true;
        break;
      }
      state.sources = headers.flatMap((h, i) =>
        h?.word === state!.word ? [i] : [],
      );
      state.source = 0;
      state.remaining = headers.reduce(
        (n, h) => n + (h && h.word === state!.word ? h.df : 0),
        0,
      );
      const header = termRecord(state.word, state.remaining);
      await writer.append(header);
      emitted += header.length;
      for (const i of state.sources)
        readers[i].consume((await readers[i].peek())!);
    }
    const i = state.sources![state.source!],
      reader = readers[i],
      record = await reader.peek();
    if (!record || view(record).getUint32(4, true) === 1) {
      if (++state.source! >= state.sources!.length) {
        if (state.remaining) throw Error("Merged document frequency mismatch");
        state.word = undefined;
        state.sources = undefined;
        state.source = undefined;
        state.remaining = undefined;
      }
      continue;
    }
    if (view(record).getUint32(4, true) !== 2)
      throw Error("Unknown construction record");
    const batch = reader.contiguousRows(
      Math.min(byteBudget - emitted, writer.target - writer.bytes),
    );
    await writer.appendRows(batch.bytes);
    emitted += batch.bytes.length;
    state.remaining! -= batch.count;
    if (state.remaining! < 0) throw Error("Merged document frequency mismatch");
    reader.consume(batch.bytes);
  }
  await writer.finish();
  state.cursors = readers.map((r) => r.cursor);
  return { state, chunks: writer.chunks, emitted };
}
