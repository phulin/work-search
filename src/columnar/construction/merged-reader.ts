import {
  RunReader,
  BuildStore,
  termHeader,
  termRecord,
  type Run,
  type MergeState,
  type Cursor,
} from "./runs.js";
import { view } from "../format.js";

/** A pull-based final merge. Only rows consumed by the serving builder advance
 * cursors; no final sorted run is written or read back. */
export class MergedPostingReader {
  private readers: RunReader[];
  private state: MergeState;
  private pending?: Uint8Array;
  private headers?: (Uint8Array | undefined)[];
  private pendingSources?: number[];
  readonly cursor: Cursor = { chunk: 0, at: 0 };
  constructor(
    store: BuildStore,
    runs: Run[],
    saved?: MergeState,
    readonly range?: { firstWord?: string; endWord?: string },
  ) {
    if (
      !runs.length ||
      runs.length > 16 ||
      runs.some((r, i) => i > 0 && runs[i - 1].next !== r.first)
    )
      throw Error("Invalid fused merge coverage");
    this.state = saved
      ? structuredClone(saved)
      : { cursors: runs.map(() => ({ chunk: 0, at: 0 })) };
    if (this.state.cursors.length !== runs.length)
      throw Error("Invalid fused merge checkpoint");
    this.readers = runs.map(
      (r, i) => new RunReader(store, r.chunks, this.state.cursors[i]),
    );
    this.initial = !saved;
  }
  private initial: boolean;
  async peek(): Promise<Uint8Array | undefined> {
    if (this.pending) return this.pending;
    if (this.state.done) return;
    if (this.initial) {
      this.initial = false;
      if (this.range?.firstWord)
        for (const r of this.readers) await r.seekTerm(this.range.firstWord);
    }
    for (;;) {
      if (this.state.word === undefined) {
        this.headers = [];
        for (let at = 0; at < this.readers.length; at += 4)
          this.headers.push(
            ...(await Promise.all(
              this.readers.slice(at, at + 4).map((r) => r.peek()),
            )),
          );
        const heads = this.headers.map((h) => h && termHeader(h));
        let word: string | undefined;
        for (const h of heads)
          if (h && (word === undefined || h.word < word)) word = h.word;
        if (
          word === undefined ||
          (this.range?.endWord !== undefined && word >= this.range.endWord)
        ) {
          this.state.done = true;
          return;
        }
        this.pendingSources = heads.flatMap((h, i) =>
          h?.word === word ? [i] : [],
        );
        const df = this.pendingSources.reduce((n, i) => n + heads[i]!.df, 0);
        return (this.pending = termRecord(word, df));
      }
      const source = this.state.sources![this.state.source!],
        row = await this.readers[source].peek();
      if (!row || view(row).getUint32(4, true) === 1) {
        if (++this.state.source! === this.state.sources!.length) {
          if (this.state.remaining !== 0) throw Error("Fused term DF mismatch");
          this.state.word = undefined;
          this.state.sources = undefined;
          this.state.source = undefined;
          this.state.remaining = undefined;
        }
        continue;
      }
      if (view(row).getUint32(4, true) !== 2)
        throw Error("Invalid fused posting row");
      return (this.pending = row);
    }
  }
  consume(row: Uint8Array) {
    if (row !== this.pending)
      throw Error("Fused reader consumed unselected row");
    if (this.state.word === undefined) {
      const header = termHeader(row);
      this.state.word = header.word;
      this.state.sources = this.pendingSources;
      this.state.source = 0;
      this.state.remaining = header.df;
      for (const i of this.pendingSources!)
        this.readers[i].consume(this.headers![i]!);
      this.headers = undefined;
      this.pendingSources = undefined;
    } else {
      this.readers[this.state.sources![this.state.source!]].consume(row);
      if (--this.state.remaining! < 0) throw Error("Fused term DF mismatch");
    }
    this.pending = undefined;
  }
  snapshot(): MergeState {
    // A peeked header has not consumed any input and can be reconstructed.
    return structuredClone({
      ...this.state,
      cursors: this.readers.map((r) => r.cursor),
    });
  }
}
