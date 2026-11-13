import { DocumentPackage } from "../document-package.js";
import {
  encodePairColumns,
  mergePairPackets,
  PairPacket,
  type PairColumnRow,
} from "../pair-packet.js";
import { concat, view, u32, unpack } from "../format.js";
import { BuildStore, type Chunk } from "./runs.js";
export interface PairRun {
  first: number;
  end: number;
  selection: string;
  chunks: (Chunk & { firstKey?: number })[];
}
export interface PairSelection {
  documents: number;
  terms: { id: number }[];
  pairs: {
    key: number;
    a: number;
    b: number;
    df: number;
    occurrences: number;
    cost: number;
  }[];
}
class Writer {
  chunks: PairRun["chunks"] = [];
  parts: Uint8Array[] = [];
  bytes = 0;
  last = -1;
  firstKey = -1;
  constructor(readonly store: BuildStore) {}
  async append(key: number, packet: Uint8Array) {
    if (key <= this.last || packet.length > 2 * 1048576)
      throw Error("Unsorted or oversized pair packet");
    if (this.bytes && this.bytes + packet.length + 8 > 1048576)
      await this.flush();
    if (!this.bytes) this.firstKey = key;
    this.parts.push(u32([packet.length + 8, key]), packet);
    this.bytes += packet.length + 8;
    this.last = key;
  }
  async flush() {
    if (this.bytes)
      this.chunks.push({
        ...(await this.store.put(concat(this.parts))),
        firstKey: this.firstKey,
      });
    this.parts = [];
    this.bytes = 0;
  }
}
class Cursor {
  chunk = 0;
  at = 0;
  bytes?: Uint8Array;
  last = -1;
  constructor(
    readonly store: BuildStore,
    readonly run: PairRun,
    readonly firstKey?: number,
  ) {
    if (firstKey !== undefined) {
      let lo = 0,
        hi = run.chunks.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1,
          key = run.chunks[mid].firstKey;
        if (key === undefined) throw Error("Pair run lacks restart keys");
        if (key <= firstKey) lo = mid + 1;
        else hi = mid;
      }
      this.chunk = Math.max(0, lo - 1);
    }
  }
  async head(): Promise<{ key: number; packet: Uint8Array } | undefined> {
    for (;;) {
      if (!this.bytes || this.at === this.bytes.length) {
        if (this.chunk === this.run.chunks.length) return;
        this.bytes = await this.store.get(this.run.chunks[this.chunk++]);
        this.at = 0;
      }
      const v = view(this.bytes),
        n = v.getUint32(this.at, true),
        key = v.getUint32(this.at + 4, true);
      if (n < 40 || this.at + n > this.bytes.length || key <= this.last)
        throw Error("Invalid pair run record");
      if (this.firstKey !== undefined && key < this.firstKey) {
        this.take();
        continue;
      }
      return { key, packet: this.bytes.subarray(this.at + 8, this.at + n) };
    }
  }
  take() {
    const n = view(this.bytes!).getUint32(this.at, true);
    this.last = view(this.bytes!).getUint32(this.at + 4, true);
    this.at += n;
  }
}
/** Each input cursor retains one small physical chunk. Occurrence spans are
 * copied once per merge level without unpacking positions or token context. */
export async function mergePairOccurrenceRuns(
  store: BuildStore,
  runs: PairRun[],
  range?: { firstKey: number; endKey: number },
): Promise<PairRun> {
  if (
    !runs.length ||
    runs.length > 4 ||
    runs.some(
      (r, i) =>
        r.selection !== runs[0].selection ||
        (i > 0 && r.first !== runs[i - 1].end),
    )
  )
    throw Error("Invalid pair occurrence merge coverage");
  if (
    range &&
    (!Number.isInteger(range.firstKey) ||
      !Number.isInteger(range.endKey) ||
      range.firstKey < 0 ||
      range.endKey > 2 ** 32 ||
      range.endKey <= range.firstKey)
  )
    throw Error("Invalid pair merge key range");
  const cursors = runs.map((r) => new Cursor(store, r, range?.firstKey)),
    writer = new Writer(store);
  const heads = await Promise.all(cursors.map((c) => c.head()));
  for (;;) {
    const key = Math.min(...heads.map((h) => h?.key ?? Infinity));
    if (key === Infinity || (range && key >= range.endKey)) break;
    const packets: PairPacket[] = [],
      selected: number[] = [];
    heads.forEach((h, i) => {
      if (h?.key === key) {
        packets.push(new PairPacket(h.packet));
        selected.push(i);
      }
    });
    await writer.append(key, mergePairPackets(packets));
    for (const i of selected) {
      cursors[i].take();
      heads[i] = await cursors[i].head();
    }
  }
  await writer.flush();
  return {
    first: runs[0].first,
    end: runs.at(-1)!.end,
    selection: runs[0].selection,
    chunks: writer.chunks,
  };
}
/** Older in-progress runs lack restart fences. Read only their first record
 * header; actual range execution still validates each complete immutable chunk. */
export async function indexPairOccurrenceRuns(
  store: BuildStore,
  runs: PairRun[],
) {
  const indexed = structuredClone(runs),
    jobs = indexed
      .flatMap((r) => r.chunks)
      .filter((c) => c.firstKey === undefined);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, jobs.length) }, async () => {
      for (;;) {
        const chunk = jobs[next++];
        if (!chunk) return;
        store.requests++;
        const result = await store.bucket.get(chunk.key, {
          range: { offset: 0, length: 8 },
        });
        if (!result || result.size !== chunk.size)
          throw Error("Invalid pair restart source");
        const bytes = new Uint8Array(await result.arrayBuffer());
        store.bytes += bytes.length;
        if (bytes.length !== 8 || view(bytes).getUint32(0, true) < 40)
          throw Error("Invalid pair restart header");
        chunk.firstKey = view(bytes).getUint32(4, true);
      }
    }),
  );
  for (const run of indexed)
    if (
      run.chunks.some((c, i) => i && c.firstKey! <= run.chunks[i - 1].firstKey!)
    )
      throw Error("Unsorted pair restart keys");
  return indexed;
}
/** Selected pair rows are buffered over short document ranges. A long document
 * retains numeric columns rather than a JavaScript object per occurrence. */
export async function documentGroupPairRuns(
  store: BuildStore,
  bytes: Uint8Array,
  offsets: Uint32Array,
  first: number,
  selection: PairSelection,
  selectionHash: string,
) {
  const width = selection.terms.length;
  if (
    !width ||
    width > 65536 ||
    selection.pairs.length > 4096 ||
    offsets.length < 2 ||
    offsets[0] !== 0 ||
    offsets.at(-1) !== bytes.length
  )
    throw Error("Invalid positional pair group");
  const ranks = new Map(selection.terms.map((t, i) => [t.id, i])),
    selected = new Map(selection.pairs.map((p) => [p.key, p])),
    runs: PairRun[] = [];
  let rows = new Map<number, PairColumnRow[]>(),
    records = 0,
    occurrences = 0,
    start = first;
  const flush = async (end: number) => {
    const writer = new Writer(store);
    for (const key of [...rows.keys()].sort((a, b) => a - b)) {
      const descriptor = selected.get(key)!,
        packet = encodePairColumns(descriptor.a, descriptor.b, rows.get(key)!);
      await writer.append(key, packet);
    }
    await writer.flush();
    runs.push({
      first: start,
      end,
      selection: selectionHash,
      chunks: writer.chunks,
    });
    rows = new Map();
    records = occurrences = 0;
    start = end;
  };
  for (let row = 0; row + 1 < offsets.length; row++) {
    const doc = first + row,
      pkg = new DocumentPackage(
        bytes.subarray(offsets[row], offsets[row + 1]),
        doc,
      ),
      document = new Map<number, PairColumnRow>();
    for (let field = 0; field < 2; field++) {
      const tokens = pkg.tokens(field);
      let a = tokens.length ? ranks.get(tokens[0]) : undefined;
      for (let p = 1; p < tokens.length; p++) {
        const b = ranks.get(tokens[p]);
        if (a !== undefined && b !== undefined) {
          const key = a * width + b,
            descriptor = selected.get(key);
          if (descriptor) {
            if (descriptor.a !== tokens[p - 1] || descriptor.b !== tokens[p])
              throw Error("Pair selection vocabulary mismatch");
            let entry = document.get(key);
            if (!entry) {
              const empty = () => ({
                positions: [] as number[],
                previous: [] as number[],
                next: [] as number[],
              });
              entry = { doc, body: empty(), title: empty() };
              document.set(key, entry);
            }
            const c = field ? entry.title : entry.body;
            (c.positions as number[]).push(p - 1);
            (c.previous as number[]).push(p > 1 ? tokens[p - 2] + 1 : 0);
            (c.next as number[]).push(
              p + 1 < tokens.length ? tokens[p + 1] + 1 : 0,
            );
            occurrences++;
          }
        }
        a = b;
      }
    }
    for (const [key, entry] of document) {
      const list = rows.get(key) ?? [];
      list.push(entry);
      rows.set(key, list);
      records++;
    }
    if (records >= 8192 || occurrences >= 262144) await flush(doc + 1);
  }
  if (start < first + offsets.length - 1)
    await flush(first + offsets.length - 1);
  return runs;
}
export async function* pairRunEntries(
  store: BuildStore,
  run: PairRun,
  range?: { firstKey: number; endKey: number },
) {
  const cursor = new Cursor(store, run, range?.firstKey);
  for (let h = await cursor.head(); h; h = await cursor.head()) {
    if (range && h.key >= range.endKey) break;
    yield h;
    cursor.take();
  }
}
