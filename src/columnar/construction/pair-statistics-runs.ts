import { BuildStore, type Chunk } from "./runs.js";
import { PairStatistics, statisticsOutput } from "./pair-statistics.js";
import type { StagingContainer } from "./staging-container.js";

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
    readonly container?: StagingContainer,
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
    const task = (
      this.container ? this.container.append(bytes) : this.store.put(bytes)
    )
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
  container?: StagingContainer,
): Promise<PairStatisticsRun> {
  const writer = new Writer(store, stats.first, stats.end, container);
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
  private window = new Map<number, Uint8Array>();
  constructor(
    readonly store: BuildStore,
    readonly run: PairStatisticsRun,
  ) {}
  async fill() {
    if (this.stats && this.row < this.stats.count) return;
    this.stats = undefined;
    if (this.chunk === this.run.chunks.length) return;
    if (!this.window.has(this.chunk)) {
      let end = this.chunk + 1,
        bytes = this.run.chunks[this.chunk].size;
      while (
        end < this.run.chunks.length &&
        this.run.chunks[end].key === this.run.chunks[this.chunk].key &&
        bytes + this.run.chunks[end].size <= 2 * 1048576
      )
        bytes += this.run.chunks[end++].size;
      const raw = await this.store.getMany(
        this.run.chunks.slice(this.chunk, end),
        2 * 1048576,
      );
      raw.forEach((b, i) => this.window.set(this.chunk + i, b));
    }
    const bytes = this.window.get(this.chunk)!;
    this.window.delete(this.chunk++);
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
