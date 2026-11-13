import { BuildStore, type Chunk } from "./runs.js";
import { PairStatistics, statisticsOutput } from "./pair-statistics.js";

export interface PairStatisticsRun {
  first: number;
  end: number;
  vocabulary: string;
  chunks: Chunk[];
}
const CHUNK_ROWS = 32768;
class Writer {
  chunks: Chunk[] = [];
  count = 0;
  output;
  pending = new Set<Promise<void>>();
  failure?: unknown;
  constructor(
    readonly store: BuildStore,
    readonly first: number,
    readonly end: number,
  ) {
    this.output = statisticsOutput(CHUNK_ROWS, first, end);
  }
  put(key: number, df: number, occurrences: number) {
    this.output.put(this.count++, key, df, occurrences);
  }
  async flush() {
    if (!this.count) return;
    while (this.pending.size >= 2) await Promise.race(this.pending);
    if (this.failure) throw this.failure;
    const index = this.chunks.length,
      bytes = this.output.finish(this.count);
    this.chunks.length++;
    const task = this.store
      .put(bytes)
      .then(
        (chunk) => {
          this.chunks[index] = chunk;
        },
        (error) => {
          this.failure = error;
        },
      )
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
    this.count = 0;
    this.output = statisticsOutput(CHUNK_ROWS, this.first, this.end);
  }
  async finish() {
    await this.flush();
    await Promise.all(this.pending);
    if (this.failure) throw this.failure;
  }
}
export async function storePairStatistics(
  store: BuildStore,
  stats: PairStatistics,
  vocabulary: string,
): Promise<PairStatisticsRun> {
  const writer = new Writer(store, stats.first, stats.end);
  for (let row = 0; row < stats.count; row++) {
    writer.put(stats.key(row), stats.df(row), stats.occurrences(row));
    if (writer.count === CHUNK_ROWS) await writer.flush();
  }
  await writer.finish();
  return {
    first: stats.first,
    end: stats.end,
    vocabulary,
    chunks: writer.chunks,
  };
}
/** One active and one prefetched chunk per input; no whole-corpus dictionary. */
class Cursor {
  chunk = 0;
  row = 0;
  stats?: PairStatistics;
  last = -1;
  next?: Promise<Uint8Array>;
  constructor(
    readonly store: BuildStore,
    readonly run: PairStatisticsRun,
  ) {}
  async fill() {
    if (this.stats && this.row < this.stats.count) return;
    this.stats = undefined;
    if (this.chunk === this.run.chunks.length) return;
    const bytes = await (this.next ??
      this.store.get(this.run.chunks[this.chunk]));
    this.chunk++;
    this.next =
      this.chunk < this.run.chunks.length
        ? this.store.get(this.run.chunks[this.chunk])
        : undefined;
    void this.next?.catch(() => {});
    const stats = new PairStatistics(bytes);
    if (
      stats.first !== this.run.first ||
      stats.end !== this.run.end ||
      !stats.count ||
      stats.key(0) <= this.last
    )
      throw Error("Invalid pair statistics stream coverage/order");
    this.stats = stats;
    this.row = 0;
  }
  get key() {
    return this.stats ? this.stats.key(this.row) : Infinity;
  }
  take() {
    const stats = this.stats!,
      row = this.row++;
    this.last = stats.key(row);
    return { df: stats.df(row), occurrences: stats.occurrences(row) };
  }
}
export async function mergePairStatisticsRuns(
  store: BuildStore,
  runs: PairStatisticsRun[],
): Promise<PairStatisticsRun> {
  if (
    !runs.length ||
    runs.length > 4 ||
    runs.some(
      (r, i) =>
        r.first >= r.end ||
        r.vocabulary !== runs[0].vocabulary ||
        (i > 0 && r.first !== runs[i - 1].end),
    )
  )
    throw Error("Invalid pair statistics merge coverage");
  const first = runs[0].first,
    end = runs.at(-1)!.end,
    cursors = runs.map((r) => new Cursor(store, r)),
    writer = new Writer(store, first, end);
  await Promise.all(cursors.map((c) => c.fill()));
  for (;;) {
    let key = Infinity;
    for (const c of cursors) key = Math.min(key, c.key);
    if (key === Infinity) break;
    let df = 0,
      occurrences = 0;
    const exhausted: Cursor[] = [];
    for (const c of cursors)
      if (c.key === key) {
        const counts = c.take();
        df += counts.df;
        occurrences += counts.occurrences;
        if (c.row === c.stats!.count) exhausted.push(c);
      }
    writer.put(key, df, occurrences);
    if (writer.count === CHUNK_ROWS) await writer.flush();
    if (exhausted.length) await Promise.all(exhausted.map((c) => c.fill()));
  }
  await writer.finish();
  return { first, end, vocabulary: runs[0].vocabulary, chunks: writer.chunks };
}
