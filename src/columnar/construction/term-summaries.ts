import { concat, u32, view } from "../format.js";
import { BuildStore, type Chunk } from "./runs.js";
import { transformBlock } from "./block-codec.js";

export interface TermSummary {
  word: string;
  df: number;
  body: number;
  title: number;
}
export interface SummaryRun {
  version: 3;
  first: number;
  end: number;
  chunks: Chunk[];
}
export interface SummaryCursor {
  chunk: number;
  row: number;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export function encodeSummaries(rows: TermSummary[]) {
  const parts: Uint8Array[] = [u32([0x33534d43, rows.length])];
  let last: string | undefined;
  for (const row of rows) {
    if (
      (last !== undefined && row.word <= last) ||
      !row.df ||
      row.df > 0xffffffff ||
      !Number.isSafeInteger(row.body) ||
      !Number.isSafeInteger(row.title) ||
      row.body < 0 ||
      row.title < 0 ||
      row.body + row.title < row.df
    )
      throw Error("Invalid term summary");
    const word = encoder.encode(row.word),
      header = new Uint8Array(24),
      v = view(header);
    v.setUint32(0, word.length, true);
    v.setUint32(4, row.df, true);
    v.setFloat64(8, row.body, true);
    v.setFloat64(16, row.title, true);
    parts.push(header, word);
    last = row.word;
  }
  return concat(parts);
}
export function decodeSummaries(bytes: Uint8Array): TermSummary[] {
  if (bytes.length < 8 || view(bytes).getUint32(0, true) !== 0x33534d43)
    throw Error("Invalid summary version");
  const v = view(bytes),
    count = v.getUint32(4, true),
    rows: TermSummary[] = [];
  let p = 8;
  for (let i = 0; i < count; i++) {
    if (p + 24 > bytes.length) throw Error("Truncated term summary");
    const n = v.getUint32(p, true);
    if (p + 24 + n > bytes.length) throw Error("Truncated summary word");
    rows.push({
      word: decoder.decode(bytes.subarray(p + 24, p + 24 + n)),
      df: v.getUint32(p + 4, true),
      body: v.getFloat64(p + 8, true),
      title: v.getFloat64(p + 16, true),
    });
    p += 24 + n;
  }
  if (p !== bytes.length) throw Error("Trailing term summary bytes");
  // Validate ordering and numeric ranges on every read, including resumed jobs.
  encodeSummaries(rows);
  return rows;
}
export class SummaryWriter {
  chunks: Chunk[] = [];
  rows: TermSummary[] = [];
  private parts: {
    data: Uint8Array;
    first: string;
    last: string;
    count: number;
  }[] = [];
  private bytes = 0;
  private last?: string;
  constructor(
    readonly store: BuildStore,
    readonly blockRows = 4096,
    readonly containerBytes = 4 * 1048576,
  ) {}
  async append(row: TermSummary) {
    if (this.last !== undefined && row.word <= this.last)
      throw Error("Unsorted summary output");
    this.last = row.word;
    this.rows.push(row);
    if (this.rows.length >= this.blockRows) await this.flushBlock();
  }
  private async flushBlock() {
    if (!this.rows.length) return;
    const data = await transformBlock(encodeSummaries(this.rows));
    if (this.bytes && this.bytes + data.length > this.containerBytes)
      await this.flushContainer();
    this.parts.push({
      data,
      first: this.rows[0].word,
      last: this.rows.at(-1)!.word,
      count: this.rows.length,
    });
    this.bytes += data.length;
    this.rows = [];
  }
  private async flushContainer() {
    const refs = await this.store.putParts(this.parts.map((p) => p.data));
    refs.forEach((ref, i) =>
      this.chunks.push({
        ...ref,
        firstWord: this.parts[i].first,
        lastWord: this.parts[i].last,
        terms: this.parts[i].count,
      }),
    );
    this.parts = [];
    this.bytes = 0;
  }
  async finish() {
    await this.flushBlock();
    await this.flushContainer();
    return this.chunks;
  }
}
export class SummaryReader {
  cursor: SummaryCursor;
  private rows?: TermSummary[];
  constructor(
    readonly store: BuildStore,
    readonly run: SummaryRun,
    saved: SummaryCursor = { chunk: 0, row: 0 },
  ) {
    this.cursor = { ...saved };
    if (
      !Number.isInteger(saved.chunk) ||
      saved.chunk < 0 ||
      saved.chunk > run.chunks.length ||
      !Number.isInteger(saved.row) ||
      saved.row < 0
    )
      throw Error("Invalid summary cursor");
  }
  async peek() {
    if (this.cursor.chunk === this.run.chunks.length) return;
    if (!this.rows) {
      const ref = this.run.chunks[this.cursor.chunk];
      this.rows = decodeSummaries(
        await transformBlock(await this.store.get(ref), true),
      );
      if (
        this.rows.length !== ref.terms ||
        this.rows[0]?.word !== ref.firstWord ||
        this.rows.at(-1)?.word !== ref.lastWord ||
        this.cursor.row >= this.rows.length
      )
        throw Error("Summary fence/cursor mismatch");
    }
    return this.rows[this.cursor.row];
  }
  consume() {
    if (!this.rows) throw Error("Summary cursor not loaded");
    if (++this.cursor.row === this.rows.length) {
      this.cursor.chunk++;
      this.cursor.row = 0;
      this.rows = undefined;
    }
  }
}
export interface SummaryMergeState {
  version: 3;
  cursors: SummaryCursor[];
  done?: boolean;
}
export async function mergeSummaries(
  store: BuildStore,
  runs: SummaryRun[],
  saved?: SummaryMergeState,
  termBudget = 100000,
) {
  if (
    !runs.length ||
    runs.length > 16 ||
    runs.some(
      (r, i) =>
        r.version !== 3 ||
        r.first >= r.end ||
        (i > 0 && r.first !== runs[i - 1].end),
    )
  )
    throw Error(
      "Summary merge requires disjoint consecutive document coverage",
    );
  if (saved && (saved.version !== 3 || saved.cursors.length !== runs.length))
    throw Error("Invalid summary checkpoint");
  const readers = runs.map(
      (run, i) => new SummaryReader(store, run, saved?.cursors[i]),
    ),
    writer = new SummaryWriter(store),
    histogram = new Map<number, number>();
  let count = 0,
    done = false;
  const started = performance.now();
  const heads = await Promise.all(readers.map((r) => r.peek()));
  while (count < termBudget && performance.now() - started < 15000) {
    let word: string | undefined;
    for (const h of heads)
      if (h && (word === undefined || h.word < word)) word = h.word;
    if (word === undefined) {
      done = true;
      break;
    }
    const row: TermSummary = { word, df: 0, body: 0, title: 0 };
    for (let i = 0; i < heads.length; i++)
      if (heads[i]?.word === word) {
        row.df += heads[i]!.df;
        row.body += heads[i]!.body;
        row.title += heads[i]!.title;
        readers[i].consume();
        heads[i] = await readers[i].peek();
      }
    if (row.df > runs.at(-1)!.end - runs[0].first)
      throw Error("Summary DF exceeds coverage");
    await writer.append(row);
    count++;
    histogram.set(row.df, (histogram.get(row.df) ?? 0) + 1);
  }
  if (heads.every((h) => !h)) done = true;
  return {
    version: 3,
    first: runs[0].first,
    end: runs.at(-1)!.end,
    chunks: await writer.finish(),
    count,
    histogram: [...histogram].sort((a, b) => b[0] - a[0]),
    state: {
      version: 3,
      cursors: readers.map((r) => r.cursor),
      done,
    } as SummaryMergeState,
  };
}
