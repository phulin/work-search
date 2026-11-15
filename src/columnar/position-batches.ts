import type { Ref } from "./format.js";
import type { Reader } from "./storage.js";
import type { ScoreBatch } from "./score-batch.js";

type Columns = ReturnType<ScoreBatch["columns"]>;
/** Keep only scored candidates, not a copy of every decoded posting or the
 * full-band handle/score workspaces. The scoring workspace can then be reused. */
export function verificationColumns(
  columns: Columns[],
  docs: Uint32Array,
  first: number,
) {
  return columns.map((c) => {
    let count = 0;
    for (const doc of docs) if (c.handle[doc - first]) count++;
    const out = {
      docs: new Uint32Array(count),
      body: new Uint32Array(count),
      title: new Uint32Array(count),
      blockIndex: new Uint32Array(count),
      blockRow: new Uint8Array(count),
    };
    let at = 0;
    for (const doc of docs) {
      const row = c.handle[doc - first] - 1;
      if (row < 0) continue;
      out.docs[at] = doc;
      out.body[at] = c.body[row];
      out.title[at] = c.title[row];
      out.blockIndex[at] = c.blockIndex[row];
      out.blockRow[at++] = c.blockRow[row];
    }
    return out;
  });
}

export interface PositionWindow {
  count: number;
  bytes: number;
  refs(from: number, to: number): Ref[];
  run(from: number, to: number, data: ReadonlyMap<string, Uint8Array>): void;
  release(): void;
}

/** Score several windows against the last verified threshold, then fetch their
 * selected positional blocks together. A weaker threshold adds work only;
 * queued, unverified candidates never raise it. Consume in document order.
 * Page-backed views remain held until the entire fetch batch has been used. */
export class PositionBatches {
  private windows: PositionWindow[] = [];
  private bytes = 0;
  constructor(
    readonly reader: Reader,
    readonly limit = 4 * 1048576,
  ) {}
  async add(window: PositionWindow) {
    if (
      this.windows.length &&
      (this.windows.length >= 8 || this.bytes + window.bytes > this.limit)
    )
      await this.flush();
    this.windows.push(window);
    this.bytes += window.bytes;
    this.reader.stats.peakPositionNumericBytes = Math.max(
      this.reader.stats.peakPositionNumericBytes,
      this.bytes,
    );
    if (this.bytes >= this.limit || this.windows.length >= 8)
      await this.flush();
  }
  async flush() {
    if (!this.windows.length) return;
    let wi = 0,
      from = 0;
    while (wi < this.windows.length) {
      const tasks: { w: PositionWindow; from: number; to: number }[] = [];
      const refs = new Map<string, Ref>();
      while (wi < this.windows.length) {
        const w = this.windows[wi];
        if (from === w.count) {
          wi++;
          from = 0;
          continue;
        }
        let to = Math.min(w.count, from + 256),
          selected: Ref[],
          footprint: number;
        for (;;) {
          selected = w.refs(from, to);
          const union = new Map(refs);
          for (const ref of selected) union.set(this.reader.key(ref), ref);
          footprint = this.reader.positionFootprint([...union.values()]);
          if (footprint <= this.limit || tasks.length || to - from === 1) break;
          to = from + Math.max(1, Math.floor((to - from) / 2));
        }
        if (footprint > this.limit && tasks.length) break;
        for (const ref of selected!) refs.set(this.reader.key(ref), ref);
        tasks.push({ w, from, to });
        from = to;
        if (footprint! >= this.limit) break;
      }
      const list = [...refs.values()],
        footprint = this.reader.positionFootprint(list);
      this.reader.stats.positionBatchCount++;
      this.reader.stats.maxPositionFootprintBytes = Math.max(
        this.reader.stats.maxPositionFootprintBytes,
        footprint,
      );
      this.reader.stats.peakPositionBufferBytes = Math.max(
        this.reader.stats.peakPositionBufferBytes,
        footprint + this.bytes,
      );
      const raw = await this.reader.positions(list);
      const data = new Map(
        list.map((ref, i) => [this.reader.key(ref), raw[i]]),
      );
      for (const task of tasks) task.w.run(task.from, task.to, data);
    }
    for (const w of this.windows) w.release();
    this.windows = [];
    this.bytes = 0;
  }
}
