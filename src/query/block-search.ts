import { SearchRuntime, postingSize } from "./runtime.js";
import { LOCAL, type BinaryIndex, type Entry } from "../format/index.js";
import {
  BLOCK_SIZE,
  decodeDirectory,
  directoryLength,
  type Block,
} from "../format/blocks.js";
import { decodeBlockInto } from "../format/decode-block.js";
import { decodeFrequencies, type DecodedPostings } from "../format/codec.js";
import { lowerBound } from "./sets.js";
import type { Node } from "./parser.js";
import type { Read } from "./load.js";
export function blockEligible(n: Node): boolean {
  return (
    n.kind === "term" ||
    ((n.kind === "and" || n.kind === "or") &&
      blockEligible(n.left) &&
      blockEligible(n.right))
  );
}
interface Heap {
  heap: { score: number; doc: number }[];
  add(doc: number, score: number): void;
}
class Cursor {
  blocks: Block[] = [];
  block = 0;
  row = 0;
  list?: DecodedPostings;
  slab: Uint8Array = new Uint8Array(0);
  start = 0;
  end = 0;
  constructor(
    readonly e: Entry,
    readonly read: Read,
    readonly field: "all" | "body" | "title",
    readonly generation: string,
    readonly runtime?: SearchRuntime,
  ) {}
  key(kind: string, offset = 0) {
    return JSON.stringify([
      this.generation,
      this.e.term,
      this.e.crc,
      kind,
      offset,
    ]);
  }
  async init() {
    if (this.e.df <= BLOCK_SIZE) {
      this.list = decodeFrequencies(
        await this.read(this.e, false, 0, this.e.length),
        this.e.df,
        this.e.crc,
      );
      return;
    }
    const cached = this.runtime?.get<Block[]>(this.key("directory"));
    if (cached) {
      this.blocks = cached;
      return;
    }
    // Broad remote lists favor one read over many sequential object requests.
    const bytes = await this.read(
      this.e,
      false,
      0,
      this.e.object === LOCAL
        ? directoryLength(this.e.df, this.e.format)
        : this.e.length,
    );
    if (this.e.object !== LOCAL) {
      this.slab = bytes;
      this.start = 0;
      this.end = bytes.length;
    }
    this.blocks = decodeDirectory(
      bytes.subarray(0, directoryLength(this.e.df, this.e.format)),
      this.e.df,
      this.e.length,
      this.e.positionLength,
      this.e.crc,
    );
    this.runtime?.set(
      this.key("directory"),
      this.blocks,
      this.blocks.length * 180,
    );
  }
  get doc() {
    return this.list?.docs[this.row] ?? Infinity;
  }
  advance(target: number): boolean {
    if (
      this.doc === Infinity &&
      (!this.blocks.length || this.block >= this.blocks.length)
    )
      return true;
    if (
      !this.list ||
      (this.blocks.length && target > this.blocks[this.block].last)
    )
      return false;
    this.row = lowerBound(this.list.docs, target, this.row);
    while (
      this.row < this.list.docs.length &&
      this.field !== "all" &&
      !this.list[this.field][this.row]
    )
      this.row++;
    return this.row < this.list.docs.length || !this.blocks.length;
  }
  async seek(target: number) {
    if (this.blocks.length) {
      let lo = this.block,
        hi = this.blocks.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (this.blocks[m].last < target) lo = m + 1;
        else hi = m;
      }
      if (lo >= this.blocks.length) {
        this.block = lo;
        this.list = undefined;
        return;
      }
      if (
        !this.list ||
        lo !== this.block ||
        this.row >= this.list.docs.length
      ) {
        this.block = lo;
        const b = this.blocks[lo];
        const cached = this.runtime?.get<DecodedPostings>(
          this.key("decoded-block", b.offset),
        );
        if (cached) {
          this.list = cached;
          this.row = 0;
          await this.seek(target);
          return;
        }
        if (b.offset < this.start || b.offset + b.length > this.end) {
          // Read ahead in bounded slabs; decode only blocks actually visited.
          let last = lo;
          while (
            last + 1 < this.blocks.length &&
            this.blocks[last + 1].offset +
              this.blocks[last + 1].length -
              b.offset <=
              65536
          )
            last++;
          this.start = this.e.object === LOCAL ? b.offset : 0;
          this.end =
            this.e.object === LOCAL
              ? this.blocks[last].offset + this.blocks[last].length
              : this.e.length;
          this.slab = await this.read(
            this.e,
            false,
            this.start,
            this.end - this.start,
          );
        }
        this.list = {
          docs: new Uint32Array(b.count),
          body: new Uint32Array(b.count),
          title: new Uint32Array(b.count),
          bytes: new Uint8Array(0),
        };
        decodeBlockInto(this.slab, b.offset - this.start, b, this.list, 0);
        this.runtime?.set(
          this.key("decoded-block", b.offset),
          this.list,
          postingSize(this.list),
        );
        this.row = 0;
      }
    }
    if (!this.list) return;
    this.row = lowerBound(this.list.docs, target, this.row);
    while (
      this.row < this.list.docs.length &&
      this.field !== "all" &&
      !this.list[this.field][this.row]
    )
      this.row++;
    if (this.row >= this.list.docs.length && this.blocks.length)
      await this.seek(this.blocks[this.block].last + 1);
  }
  max(body: boolean, title: boolean, boost: number) {
    const b = this.blocks[this.block];
    return this.doc === Infinity
      ? 0
      : b
        ? (body ? b.bodyMax! : 0) + (title ? boost * b.titleMax! : 0)
        : Infinity;
  }
}
export async function searchBlocks(
  index: BinaryIndex,
  entries: Entry[],
  ast: Node,
  read: Read,
  heap: Heap,
  limit: number,
  field: "all" | "body" | "title",
  boost: number,
  runtime?: SearchRuntime,
) {
  const cursors = entries.map(
    (e) =>
      new Cursor(
        e,
        read,
        field,
        index.generation,
        runtime && (e.object !== LOCAL || e.df * 12 <= runtime.capacity / 2)
          ? runtime
          : undefined,
      ),
  );
  await Promise.all(
    cursors.map(async (c) => {
      await c.init();
      await c.seek(0);
    }),
  );
  const byTerm = new Map(entries.map((e, i) => [e.term, i]));
  const test = (n: Node, doc: number): boolean =>
    n.kind === "term"
      ? cursors[byTerm.get(n.term)!].doc === doc
      : n.kind === "and"
        ? test(n.left, doc) && test(n.right, doc)
        : n.kind === "or"
          ? test(n.left, doc) || test(n.right, doc)
          : false;
  const conjunction = (n: Node): boolean =>
    n.kind === "term" ||
    (n.kind === "and" && conjunction(n.left) && conjunction(n.right));
  const and = conjunction(ast),
    body = field !== "title",
    title = field !== "body",
    lengths = { body: 0, title: 0 };
  const idfs = entries.map((e) =>
    Math.log(1 + (index.count - e.df + 0.5) / (e.df + 0.5)),
  );
  let target = 0,
    scored = 0,
    skippedBlocks = 0;
  while (true) {
    const pending: Promise<void>[] = [];
    for (const c of cursors)
      if (!c.advance(target)) pending.push(c.seek(target));
    if (pending.length) await Promise.all(pending);
    const doc = and
      ? Math.max(...cursors.map((c) => c.doc))
      : Math.min(...cursors.map((c) => c.doc));
    if (doc === Infinity) break;
    if (and && cursors.some((c) => c.doc !== doc)) {
      target = doc;
      continue;
    }
    if (heap.heap.length === limit) {
      let upper = 0;
      for (const c of cursors) {
        const b = c.blocks[c.block];
        if (c.doc !== Infinity) {
          if (!b) {
            upper = Infinity;
            break;
          }
          if (body) upper += b.bodyMax!;
          if (title) upper += boost * b.titleMax!;
        }
      }
      const end = Math.min(
        ...cursors
          .filter((c) => c.doc !== Infinity)
          .map((c) => c.blocks[c.block]?.last ?? doc),
      );
      const threshold = heap.heap[0];
      if (
        upper < threshold.score ||
        (upper === threshold.score && doc > threshold.doc)
      ) {
        target = end + 1;
        skippedBlocks++;
        continue;
      }
    }
    if (test(ast, doc)) {
      index.lengths(doc, lengths);
      const bn =
          1.2 * (1 - 0.75 + (0.75 * lengths.body) / (index.avgBody || 1)),
        tn = 1.2 * (1 - 0.75 + (0.75 * lengths.title) / (index.avgTitle || 1));
      let score = 0;
      for (let i = 0; i < cursors.length; i++) {
        const c = cursors[i];
        if (c.doc !== doc) continue;
        const l = c.list!,
          b = l.body[c.row],
          t = l.title[c.row];
        if (body && b) score += (idfs[i] * (b * 2.2)) / (b + bn);
        if (title && t) score += boost * ((idfs[i] * (t * 2.2)) / (t + tn));
      }
      heap.add(doc, score);
      scored++;
    }
    target = doc + 1;
  }
  return { scored, skippedBlocks };
}
