import { SearchRuntime, postingSize, postingKey } from "./runtime.js";
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
export function pureConjunction(n: Node): boolean {
  return (
    n.kind === "term" ||
    (n.kind === "and" && pureConjunction(n.left) && pureConjunction(n.right))
  );
}
export function pureDisjunction(n: Node): boolean {
  return (
    n.kind === "term" ||
    (n.kind === "or" && pureDisjunction(n.left) && pureDisjunction(n.right))
  );
}
export interface BlockStats {
  visitedDocuments: number;
  cursorSeeks: number;
  cursorLoads: number;
  blocksDecoded: number;
  blockCacheHits: number;
  fullPostingCacheHits: number;
  skippedBlocks: number;
  scored: number;
  wandPivots: number;
  wandSkips: number;
}
interface Heap {
  heap: { score: number; doc: number }[];
  add(doc: number, score: number): void;
}
// One immutable data source per distinct term; duplicate AST leaves own cursors
// so (A AND B) OR A cannot consume A's rows through the other branch.
class TermData {
  blocks: Block[] = [];
  full?: DecodedPostings;
  bytes?: Uint8Array;
  loading?: Promise<void>;
  recent?: { block: number; list: DecodedPostings };
  readonly prefix: string;
  readonly idf: number;
  constructor(
    readonly index: BinaryIndex,
    readonly e: Entry,
    readonly read: Read,
    readonly stats: BlockStats,
    readonly runtime?: SearchRuntime,
  ) {
    this.prefix = JSON.stringify([index.generation, e.term, e.crc]);
    this.idf = Math.log(1 + (index.count - e.df + 0.5) / (e.df + 0.5));
  }
  key(kind: string, offset = 0) {
    return this.prefix + ":" + kind + ":" + offset;
  }
  async init() {
    const cached =
      this.runtime?.get<DecodedPostings>(
        postingKey(this.index.generation, this.e),
      ) ??
      this.runtime?.get<DecodedPostings>(
        postingKey(this.index.generation, this.e, true),
      );
    if (cached && cached.docs.length === this.e.df) {
      this.full = cached;
      this.blocks = cached.blocks ?? [];
      this.stats.fullPostingCacheHits++;
      return;
    }
    if (this.e.df <= BLOCK_SIZE) {
      this.full = decodeFrequencies(
        await this.read(this.e, false, 0, this.e.length),
        this.e.df,
        this.e.crc,
      );
      this.runtime?.set(
        postingKey(this.index.generation, this.e),
        this.full,
        postingSize(this.full),
      );
      return;
    }
    const directory = this.runtime?.get<Block[]>(this.key("directory"));
    if (directory) {
      this.blocks = directory;
      return;
    }
    await this.ensureBytes();
    this.blocks = decodeDirectory(
      this.bytes!.subarray(0, directoryLength(this.e.df, this.e.format)),
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
  async ensureBytes() {
    if (this.bytes) return;
    this.loading ??= this.read(this.e, false, 0, this.e.length).then(
      (bytes) => {
        this.bytes = bytes;
      },
    );
    await this.loading;
  }
  readyBlock(i: number): DecodedPostings | undefined {
    if (this.recent?.block === i) return this.recent.list;
    const b = this.blocks[i],
      key = this.key("decoded-block", b.offset);
    const cached = this.runtime?.get<DecodedPostings>(key);
    if (cached) {
      this.stats.blockCacheHits++;
      this.recent = { block: i, list: cached };
      return cached;
    }
    if (!this.bytes) return;
    const list: DecodedPostings = {
      docs: new Uint32Array(b.count),
      body: new Uint32Array(b.count),
      title: new Uint32Array(b.count),
      bytes: new Uint8Array(0),
    };
    decodeBlockInto(this.bytes, b.offset, b, list, 0);
    this.stats.blocksDecoded++;
    this.recent = { block: i, list };
    // Avoid retaining a scan's worth of oversized local lists, as before.
    if (
      this.e.object !== LOCAL ||
      this.e.df * 12 <= (this.runtime?.capacity ?? 0) / 2
    )
      this.runtime?.set(key, list, postingSize(list));
    return list;
  }
}
class Cursor {
  row = 0;
  block = 0;
  list?: DecodedPostings;
  pending: number | undefined;
  doc = Infinity;
  constructor(
    readonly data: TermData,
    readonly field: "all" | "body" | "title",
  ) {}
  advance(target: number, countSeek = true): boolean {
    if (this.doc >= target && this.list) return true;
    if (
      countSeek &&
      target > 0 &&
      (this.doc === Infinity || target > this.doc + 1)
    )
      this.data.stats.cursorSeeks++;
    while (true) {
      let list = this.data.full;
      if (!list) {
        const blocks = this.data.blocks;
        let lo = this.block,
          hi = blocks.length;
        while (lo < hi) {
          const m = (lo + hi) >>> 1;
          if (blocks[m].last < target) lo = m + 1;
          else hi = m;
        }
        if (lo === blocks.length) {
          this.doc = Infinity;
          this.list = undefined;
          this.block = lo;
          return true;
        }
        if (lo !== this.block || !this.list) {
          this.block = lo;
          this.row = 0;
          this.list = undefined;
        }
        list =
          lo === this.block && this.list ? this.list : this.data.readyBlock(lo);
        if (!list) {
          this.pending = target;
          return false;
        }
      }
      this.list = list;
      this.row = lowerBound(list.docs, target, this.row);
      while (
        this.row < list.docs.length &&
        this.field !== "all" &&
        !list[this.field][this.row]
      )
        this.row++;
      if (this.row === list.docs.length) {
        if (!this.data.full) {
          const next = this.data.blocks[this.block].last + 1;
          this.list = undefined;
          target = next;
          continue;
        }
        this.doc = Infinity;
      } else this.doc = list.docs[this.row];
      return true;
    }
  }
  async resolve() {
    const target = this.pending;
    this.pending = undefined;
    if (target !== undefined) {
      this.data.stats.cursorLoads++;
      await this.data.ensureBytes();
      if (!this.advance(target, false)) throw Error("Unresolved block cursor");
    }
  }
  get last() {
    return this.data.blocks.length
      ? (this.data.blocks[
          this.data.full ? Math.floor(this.row / BLOCK_SIZE) : this.block
        ]?.last ?? Infinity)
      : Infinity;
  }
  get impact() {
    return this.data.blocks[
      this.data.full ? Math.floor(this.row / BLOCK_SIZE) : this.block
    ];
  }
}
interface Iterator {
  doc: number;
  cost: number;
  advance(target: number): boolean;
}
function booleanIterator(
  n: Node,
  data: Map<string, TermData>,
  field: "all" | "body" | "title",
  leaves: Cursor[],
): Iterator {
  if (n.kind === "term") {
    const cursor = new Cursor(data.get(n.term)!, field);
    leaves.push(cursor);
    return {
      get doc() {
        return cursor.doc;
      },
      cost: cursor.data.e.df,
      advance: (target) => cursor.advance(target),
    };
  }
  if (n.kind !== "and" && n.kind !== "or")
    throw Error("Invalid block Boolean plan");
  const nodes: Node[] = [];
  const flatten = (x: Node) => {
    if (x.kind === n.kind) {
      flatten(x.left);
      flatten(x.right);
    } else nodes.push(x);
  };
  flatten(n);
  const children = nodes
    .map((x) => booleanIterator(x, data, field, leaves))
    .sort((a, b) => a.cost - b.cost);
  const result: Iterator = {
    doc: Infinity,
    cost:
      n.kind === "and"
        ? children[0].cost
        : children.reduce((s, c) => s + c.cost, 0),
    advance(target) {
      if (n.kind === "or") {
        let doc = Infinity,
          ready = true;
        for (const child of children) {
          if (!child.advance(target)) ready = false;
          else if (child.doc < doc) doc = child.doc;
        }
        if (ready) result.doc = doc;
        return ready;
      }
      let doc = target,
        i = 0;
      while (i < children.length) {
        const child = children[i];
        if (!child.advance(doc)) return false;
        if (child.doc === Infinity) {
          result.doc = Infinity;
          return true;
        }
        if (child.doc > doc) {
          doc = child.doc;
          i = 0;
        } else i++;
      }
      result.doc = doc;
      return true;
    },
  };
  return result;
}
function resolve(cursors: Cursor[]): Promise<void> | undefined {
  let pending: Promise<void>[] | undefined;
  for (const c of cursors)
    if (c.pending !== undefined) (pending ??= []).push(c.resolve());
  if (pending) return Promise.all(pending).then(() => {});
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
  mode: "boolean" | "wand" = "boolean",
) {
  const stats: BlockStats = {
    visitedDocuments: 0,
    cursorSeeks: 0,
    cursorLoads: 0,
    blocksDecoded: 0,
    blockCacheHits: 0,
    fullPostingCacheHits: 0,
    skippedBlocks: 0,
    scored: 0,
    wandPivots: 0,
    wandSkips: 0,
  };
  const data = entries.map((e) => new TermData(index, e, read, stats, runtime));
  await Promise.all(data.map((d) => d.init()));
  if (mode === "wand")
    return runWand(index, data, ast, heap, limit, field, boost, stats);
  const map = new Map(data.map((d) => [d.e.term, d])),
    leaves: Cursor[] = [],
    root = booleanIterator(ast, map, field, leaves),
    scoring = data.map((d) => new Cursor(d, field));
  const body = field !== "title",
    title = field !== "body",
    lengths = { body: 0, title: 0 };
  let target = 0,
    boundEnd = -1,
    upper = Infinity;
  while (true) {
    if (!root.advance(target)) {
      await resolve(leaves);
      continue;
    }
    const doc = root.doc;
    if (doc === Infinity) break;
    let ready = true;
    for (const c of scoring) if (!c.advance(doc)) ready = false;
    if (!ready) {
      await resolve(scoring);
      continue;
    }
    stats.visitedDocuments++;
    if (heap.heap.length === limit) {
      if (doc > boundEnd) {
        boundEnd = Infinity;
        upper = 0;
        for (const c of scoring) {
          if (c.doc === Infinity) continue;
          const b = c.impact;
          if (c.last < boundEnd) boundEnd = c.last;
          if (!b) {
            upper = Infinity;
            continue;
          }
          if (body) upper += b.bodyMax!;
          if (title) upper += boost * b.titleMax!;
        }
      }
      const threshold = heap.heap[0];
      if (
        upper < threshold.score ||
        (upper === threshold.score && doc > threshold.doc)
      ) {
        stats.skippedBlocks++;
        target = boundEnd + 1;
        continue;
      }
    }
    index.lengths(doc, lengths);
    const bn = 1.2 * (1 - 0.75 + (0.75 * lengths.body) / (index.avgBody || 1)),
      tn = 1.2 * (1 - 0.75 + (0.75 * lengths.title) / (index.avgTitle || 1));
    let score = 0;
    for (const c of scoring) {
      if (c.doc !== doc) continue;
      const l = c.list!,
        b = l.body[c.row],
        t = l.title[c.row],
        idf = c.data.idf;
      if (body && b) score += (idf * (b * 2.2)) / (b + bn);
      if (title && t) score += boost * ((idf * (t * 2.2)) / (t + tn));
    }
    heap.add(doc, score);
    stats.scored++;
    target = doc + 1;
  }
  return stats;
}

// Global impacts are maxima of the persisted, independently bounded fields.
// Small lists have no directory; compute their exact maxima once after decoding.
function globalImpacts(source: TermData): [number, number] {
  let body = 0,
    title = 0;
  if (source.blocks.length) {
    for (const b of source.blocks) {
      body = Math.max(body, b.bodyMax!);
      title = Math.max(title, b.titleMax!);
    }
  } else {
    const l = source.full!,
      lengths = { body: 0, title: 0 },
      index = source.index;
    for (let i = 0; i < l.docs.length; i++) {
      index.lengths(l.docs[i], lengths);
      const b = l.body[i],
        t = l.title[i];
      if (b)
        body = Math.max(
          body,
          (source.idf * (b * 2.2)) /
            (b +
              1.2 * (1 - 0.75 + (0.75 * lengths.body) / (index.avgBody || 1))),
        );
      if (t)
        title = Math.max(
          title,
          (source.idf * (t * 2.2)) /
            (t +
              1.2 *
                (1 - 0.75 + (0.75 * lengths.title) / (index.avgTitle || 1))),
        );
    }
  }
  return [body, title];
}
async function runWand(
  index: BinaryIndex,
  data: TermData[],
  ast: Node,
  heap: Heap,
  limit: number,
  field: "all" | "body" | "title",
  boost: number,
  stats: BlockStats,
) {
  const cursors = data.map((d) => new Cursor(d, field)),
    order = data.map((_, i) => i),
    impacts = data.map(globalImpacts),
    body = field !== "title",
    title = field !== "body",
    lengths = { body: 0, title: 0 };
  const ids = new Map(data.map((d, i) => [d.e.term, i]));
  const compile = (n: Node): ((doc: number) => boolean) => {
    if (n.kind === "term") {
      const c = cursors[ids.get(n.term)!];
      return (doc) => c.doc === doc;
    }
    if (n.kind !== "and" && n.kind !== "or")
      throw Error("Invalid WAND predicate");
    const a = compile(n.left),
      b = compile(n.right);
    return n.kind === "and"
      ? (doc) => a(doc) && b(doc)
      : (doc) => a(doc) || b(doc);
  };
  const match = pureDisjunction(ast) ? undefined : compile(ast);
  for (const c of cursors) c.advance(0);
  {
    const pending = resolve(cursors);
    if (pending) await pending;
  }
  // Exact-order subset bounds are reused across changing pivot orders. At most
  // 2^16 doubles (512 KiB), charged to the query working set, no bundle bytes.
  const subsetBounds = new Float64Array(1 << data.length);
  subsetBounds.fill(NaN);
  let localEnd = -1,
    localUpper = Infinity;
  const compare = (i: number, j: number) =>
    cursors[i].doc - cursors[j].doc || i - j;
  while (true) {
    order.sort(compare);
    if (cursors[order[0]].doc === Infinity) break;
    const threshold =
      heap.heap.length === limit ? heap.heap[0].score : -Infinity;
    let mask = 0,
      pivot = -1;
    for (let p = 0; p < order.length; p++) {
      const id = order[p];
      if (cursors[id].doc === Infinity) break;
      mask |= 1 << id;
      // Preserve the scorer's original term/field addition order. Summing bounds
      // in pivot order could round down relative to an equal-scored true hit.
      let upper = subsetBounds[mask];
      if (Number.isNaN(upper)) {
        upper = 0;
        for (let j = 0; j < data.length; j++)
          if (mask & (1 << j)) {
            if (body) upper += impacts[j][0];
            if (title) upper += boost * impacts[j][1];
          }
        subsetBounds[mask] = upper;
      }
      if (upper >= threshold) {
        pivot = p;
        break;
      }
    }
    if (pivot < 0) break;
    stats.wandPivots++;
    const doc = cursors[order[pivot]].doc;
    if (cursors[order[0]].doc !== doc) {
      for (let p = 0; p < pivot; p++) {
        const c = cursors[order[p]];
        if (c.doc < doc) {
          c.advance(doc);
          stats.wandSkips++;
        }
      }
      {
        const pending = resolve(cursors);
        if (pending) await pending;
      }
      continue;
    }
    stats.visitedDocuments++;
    // A block-local bound can skip an entire doc-ID interval even when global
    // impacts selected a pivot. Skipped blocks remain undecoded where possible.
    if (heap.heap.length === limit) {
      if (doc > localEnd) {
        localUpper = 0;
        localEnd = Infinity;
        for (let i = 0; i < cursors.length; i++) {
          const c = cursors[i];
          if (c.doc === Infinity) continue;
          if (c.last < localEnd) localEnd = c.last;
          const b = c.impact;
          if (body) localUpper += b ? b.bodyMax! : impacts[i][0];
          if (title) localUpper += boost * (b ? b.titleMax! : impacts[i][1]);
        }
      }
      const worst = heap.heap[0];
      if (
        localUpper < worst.score ||
        (localUpper === worst.score && doc > worst.doc)
      ) {
        for (const c of cursors) if (c.doc <= localEnd) c.advance(localEnd + 1);
        stats.skippedBlocks++;
        {
          const pending = resolve(cursors);
          if (pending) await pending;
        }
        continue;
      }
    }
    if (!match || match(doc)) {
      index.lengths(doc, lengths);
      const bn =
          1.2 * (1 - 0.75 + (0.75 * lengths.body) / (index.avgBody || 1)),
        tn = 1.2 * (1 - 0.75 + (0.75 * lengths.title) / (index.avgTitle || 1));
      let score = 0;
      for (const c of cursors) {
        if (c.doc !== doc) continue;
        const l = c.list!,
          b = l.body[c.row],
          t = l.title[c.row],
          idf = c.data.idf;
        if (body && b) score += (idf * (b * 2.2)) / (b + bn);
        if (title && t) score += boost * ((idf * (t * 2.2)) / (t + tn));
      }
      heap.add(doc, score);
      stats.scored++;
    }
    for (const c of cursors) if (c.doc === doc) c.advance(doc + 1);
    {
      const pending = resolve(cursors);
      if (pending) await pending;
    }
  }
  return stats;
}
