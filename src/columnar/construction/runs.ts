import { pack, concat, u32, view, type Root } from "../format.js";
import { CorpusSource } from "./source.js";
import { scanText } from "./text.js";

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
  terms?: number;
  firstTerm?: { at: number; word: string };
  firstWord?: string;
  lastWord?: string;
}
export interface Run {
  chunks: Chunk[];
  first: number;
  next: number;
  count: number;
  bodyTokens: number;
  titleTokens: number;
}
export class BuildStore {
  requests = 0;
  bytes = 0;
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
    const object = await this.bucket.get(chunk.key);
    if (!object || object.customMetadata?.sha256 !== chunk.sha256)
      throw Error("Missing or changed construction chunk");
    const bytes = new Uint8Array(await object.arrayBuffer());
    this.bytes += bytes.length;
    if (bytes.length !== chunk.size || (await digest(bytes)) !== chunk.sha256)
      throw Error("Construction chunk checksum mismatch");
    return bytes;
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
  private pending = new Set<Promise<void>>();
  private failure?: unknown;
  constructor(
    readonly store: BuildStore,
    readonly target = 2 * 1048576,
    public currentWord?: string,
    readonly writeConcurrency = 1,
  ) {}
  async append(record: Uint8Array) {
    if (this.bytes && this.bytes + record.length > this.target)
      await this.flush();
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
      await this.flush();
    if (this.currentWord === undefined) throw Error("Rows lack term context");
    this.firstWord ??= this.currentWord;
    this.lastWord = this.currentWord;
    this.records.push(rows);
    this.bytes += rows.length;
  }
  async flush() {
    if (!this.bytes) return;
    const bytes = concat(this.records),
      descriptor = {
        terms: this.terms,
        firstTerm: this.firstTerm,
        firstWord: this.firstWord,
        lastWord: this.lastWord,
      };
    if (this.writeConcurrency === 1)
      this.chunks.push({
        ...(await this.store.put(bytes)),
        ...descriptor,
      });
    else {
      while (this.pending.size >= this.writeConcurrency)
        await Promise.race(this.pending);
      if (this.failure) throw this.failure;
      const i = this.chunks.length;
      this.chunks.push(undefined as unknown as Chunk);
      const pending = this.store
        .put(bytes)
        .then((chunk) => {
          this.chunks[i] = { ...chunk, ...descriptor };
        })
        .catch((error) => {
          this.failure ??= error;
        })
        .finally(() => this.pending.delete(pending));
      this.pending.add(pending);
    }
    this.records = [];
    this.bytes = 0;
    this.terms = 0;
    this.firstTerm = undefined;
    this.firstWord = undefined;
    this.lastWord = undefined;
  }
  async finish() {
    await this.flush();
    await Promise.all(this.pending);
    if (this.failure) throw this.failure;
  }
}
export function termRecord(word: string, df: number) {
  const bytes = encoder.encode(word);
  return concat([u32([12 + bytes.length, 1, df]), bytes]);
}
export function rowRecord(
  doc: number,
  bl: number,
  tl: number,
  body: number[],
  title: number[],
) {
  const b = pack(body, true),
    t = pack(title, true);
  return concat([
    u32([28 + b.length + t.length, 2, doc, bl, tl, b.length, t.length]),
    b,
    t,
  ]);
}
export interface Cursor {
  chunk: number;
  at: number;
}
export class RunReader {
  cursor: Cursor;
  data?: Uint8Array;
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
      this.data = await this.store.get(this.chunks[this.cursor.chunk]);
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
  tokenBudget = 262144,
): Promise<Run> {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 128
  )
    throw Error("Invalid ingest range");
  const part = source.part(first),
    end = Math.min(first + count, part.first + part.count),
    pointers = await source.pointers(first, end - first),
    rows = new Map<string, Uint8Array[]>(),
    started = performance.now();
  let next = first,
    bodyTokens = 0,
    titleTokens = 0;
  await source.prefetch(pointers);
  for (; next < end; next++) {
    const d = await source.document(next, pointers, next - first),
      postings = new Map<string, [number[], number[]]>();
    let bl = 0,
      tl = 0;
    for (const field of [0, 1]) {
      for (const token of scanText(field ? (d.title ?? "") : d.body).tokens()) {
        let pair = postings.get(token.word);
        if (!pair) postings.set(token.word, (pair = [[], []]));
        pair[field].push(token.position);
        if (field) tl++;
        else bl++;
      }
    }
    for (const [word, [b, t]] of postings) {
      let list = rows.get(word);
      // Copy new keys: regex substrings must not retain entire document strings.
      if (!list) rows.set(decoder.decode(encoder.encode(word)), (list = []));
      list.push(rowRecord(next, bl, tl, b, t));
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
  const writer = new RunWriter(store);
  for (const word of [...rows.keys()].sort()) {
    const list = rows.get(word)!;
    await writer.append(termRecord(word, list.length));
    for (const row of list) await writer.append(row);
  }
  await writer.flush();
  return {
    chunks: writer.chunks,
    first,
    next,
    count: next - first,
    bodyTokens,
    titleTokens,
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
    writer = new RunWriter(store, 2 * 1048576, state.word, 2),
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
