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
  chunks: Chunk[];
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
  chunks: Chunk[] = [];
  parts: Uint8Array[] = [];
  bytes = 0;
  last = -1;
  constructor(readonly store: BuildStore) {}
  async append(key: number, packet: Uint8Array) {
    if (key <= this.last || packet.length > 2 * 1048576)
      throw Error("Unsorted or oversized pair packet");
    if (this.bytes && this.bytes + packet.length + 8 > 1048576)
      await this.flush();
    this.parts.push(u32([packet.length + 8, key]), packet);
    this.bytes += packet.length + 8;
    this.last = key;
  }
  async flush() {
    if (this.bytes) this.chunks.push(await this.store.put(concat(this.parts)));
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
  ) {}
  async head(): Promise<{ key: number; packet: Uint8Array } | undefined> {
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
    return { key, packet: this.bytes.subarray(this.at + 8, this.at + n) };
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
  const cursors = runs.map((r) => new Cursor(store, r)),
    writer = new Writer(store);
  const heads = await Promise.all(cursors.map((c) => c.head()));
  for (;;) {
    const key = Math.min(...heads.map((h) => h?.key ?? Infinity));
    if (key === Infinity) break;
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
    width > 1024 ||
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
export async function* pairRunEntries(store: BuildStore, run: PairRun) {
  const cursor = new Cursor(store, run);
  for (let h = await cursor.head(); h; h = await cursor.head()) {
    yield h;
    cursor.take();
  }
}
