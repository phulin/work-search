import type { Node } from "../query/parser.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { FilterAlternative } from "./membership-anchor.js";
import type {
  ExactPhraseDirectory,
  ExactPairDescriptor,
} from "./exact-phrase-directory.js";
import { PairPacket } from "./pair-packet.js";
import { lower, concat, view } from "./format.js";
import { QueryResourceError } from "../query/evaluate.js";

export interface ExactPhrasePlan {
  words: string[];
  ids: number[];
  at: number;
  pair: ExactPairDescriptor;
  bytes: number;
  groups: ReturnType<typeof groups>;
  cost: number;
  alternativeCost: number;
}
/** Stable contiguous extents, independent of query matches and application
 * cache state. Chunk boundaries remain the decoding/restart unit. */
function groups(pair: ExactPairDescriptor) {
  const out: {
    object: number;
    offset: number;
    length: number;
  }[] = [];
  for (const c of pair.directory.ranges)
    for (let at = 0; at < c.length; at += 262144)
      out.push({
        object: c.object,
        offset: c.offset + at,
        length: Math.min(262144, c.length - at),
      });
  return out;
}
/** Full execution costs, not a membership-saving override. Estimates choose
 * plans only; every selected stream has complete positional coverage. */
export function planExactPhrases(
  ast: Node,
  directory: ExactPhraseDirectory | undefined,
  terms: ReadonlyMap<string, DirectoryTerm> | undefined,
  alternative: FilterAlternative | undefined,
  averageDocumentBytes: number,
  field: "all" | "body" | "title",
  reader?: Reader,
) {
  if (!directory || !terms || !alternative) return [];
  const phrases = new Map<string, string[]>();
  const visit = (n: Node): void => {
    if (n.kind === "phrase") phrases.set(n.terms.join("\0"), n.terms);
    else if (n.kind === "not") visit(n.child);
    else if ("left" in n) {
      visit(n.left);
      visit(n.right);
    }
  };
  visit(ast);
  const result: ExactPhrasePlan[] = [];
  for (const words of phrases.values()) {
    if (
      words.length < 2 ||
      words.length > 4 ||
      words.some((w) => !terms.has(w))
    )
      continue;
    const ids = words.map((w) => terms.get(w)!.id),
      choices: ExactPhrasePlan[] = [];
    const frequencyBytes = [...new Set(words)].reduce((n, w) => {
      const t = terms.get(w)!;
      return (
        n +
        [t.frequencies, ...(t.frequencyParts ?? [])].reduce(
          (n, r) => n + (reader?.resident(r) ? 0 : r[2]),
          0,
        )
      );
    }, 0);
    for (let at = 0; at + 1 < words.length; at++) {
      if (at > 1 || words.length - at - 2 > 1) continue;
      const pair = directory.lookup(words[at], words[at + 1]);
      if (!pair) continue;
      if (pair.directory.a !== ids[at] || pair.directory.b !== ids[at + 1])
        throw Error("Exact phrase term identity mismatch");
      const gs = groups(pair),
        bytes = gs.reduce((n, g) => n + g.length, 0),
        occ = pair.bodyOccurrences + pair.titleOccurrences;
      const missing = gs.filter(
        (g) =>
          !reader?.namedResident(
            `${pair.directory.generation}/positions-${g.object}.bin@${g.offset}`,
            g.length,
          ),
      );
      const scoreCost = frequencyBytes / 262144 + (frequencyBytes ? 8 : 0);
      const cost =
        missing.reduce((n, g) => n + g.length, 0) / 262144 +
        Math.ceil(missing.length / 6) * 8 +
        occ / 250000 +
        scoreCost;
      const completeCost =
        (alternative.frequencyBytes + alternative.positionBytes) / 262144 +
        16 +
        [...new Set(words)].reduce((n, w) => {
          const t = terms.get(w)!;
          return (
            n +
            (field !== "title" ? t.bodyOccurrences : 0) +
            (field !== "body" ? t.titleOccurrences : 0)
          );
        }, 0) /
          250000;
      const documentCost =
        (alternative.expectedCandidates * averageDocumentBytes) / 262144 +
        Math.ceil(alternative.expectedCandidates / 6) * 8;
      const alternativeCost = Math.min(completeCost, documentCost);
      // A known empty field is a complete local answer, even underneath NOT.
      const empty =
        (field === "body"
          ? pair.bodyDf
          : field === "title"
            ? pair.titleDf
            : pair.df) === 0;
      if (empty || cost < alternativeCost)
        choices.push({
          words,
          ids,
          at,
          pair,
          bytes,
          groups: empty ? [] : gs,
          cost: empty ? 0 : cost,
          alternativeCost,
        });
    }
    choices.sort((a, b) => a.cost - b.cost || a.bytes - b.bytes || a.at - b.at);
    if (choices[0]) result.push(choices[0]);
  }
  return result;
}
const EMPTY = new Uint32Array();
type MatchBatch = {
  docs: Uint32Array;
  offsets: Uint32Array[];
  starts: Uint32Array[];
};
/** Bounded encoded prefetch; each chunk decoded exactly once. A split document
 * is completed before emission so proximity sees all its phrase positions. */
async function* matches(
  plan: ExactPhrasePlan,
  reader: Reader,
  field: "all" | "body" | "title",
): AsyncGenerator<MatchBatch> {
  const pending = new Map<number, Promise<Uint8Array>>();
  const start = (i: number) => {
    if (i >= plan.groups.length || pending.has(i)) return;
    const g = plan.groups[i];
    reader.stats.exactPhraseReads++;
    reader.stats.exactPhraseBytes += g.length;
    const task = reader.named(
      `${plan.pair.directory.generation}/positions-${g.object}.bin@${g.offset}`,
      g.length,
    );
    task.catch(() => {});
    pending.set(i, task);
  };
  let doc = -1,
    body: number[] = [],
    title: number[] = [];
  let docs: number[] = [],
    offsets = [[0], [0]],
    starts: number[][] = [[], []];
  const append = () => {
    if (!body.length && !title.length) return;
    docs.push(doc);
    for (const f of [0, 1]) {
      for (const p of f ? title : body) starts[f].push(p);
      offsets[f].push(starts[f].length);
    }
  };
  const emit = (): MatchBatch => {
    const batch = {
      docs: Uint32Array.from(docs),
      offsets: offsets.map((a) => Uint32Array.from(a)),
      starts: starts.map((a) => Uint32Array.from(a)),
    };
    docs = [];
    offsets = [[0], [0]];
    starts = [[], []];
    return batch;
  };
  let carry = new Uint8Array();
  for (let i = 0; i < plan.groups.length; i++) {
    for (let j = i; j < i + 6; j++) start(j);
    const fetched = await pending.get(i)!;
    const raw = carry.length ? concat([carry, fetched]) : fetched;
    pending.delete(i);
    reader.stats.peakExactPhraseBufferBytes = Math.max(
      reader.stats.peakExactPhraseBufferBytes,
      Math.min(plan.bytes, 6 * 262144),
    );
    let at = 0;
    while (at + 24 <= raw.length) {
      const v = view(raw.subarray(at)),
        length =
          24 +
          v.getUint32(12, true) +
          v.getUint32(16, true) +
          v.getUint32(20, true);
      if (length < 24 || length > 65536)
        throw Error("Invalid exact phrase chunk length");
      if (at + length > raw.length) break;
      const p = new PairPacket(
        raw.subarray(at, at + length),
        (_row, _f, n, bytes) => {
          reader.stats.positionIntegers += n;
          reader.stats.pairContextIntegers += 2 * n;
          reader.stats.decodedBytes += bytes;
          reader.stats.exactPhraseOccurrences += n;
        },
      );
      if (
        p.a !== plan.ids[plan.at] ||
        p.b !== plan.ids[plan.at + 1] ||
        p.docs[0] < doc
      )
        throw Error("Exact phrase chunk identity mismatch");
      for (let row = 0; row < p.docs.length; row++) {
        const next = p.docs[row];
        if (doc !== next) {
          if (doc >= 0) append();
          doc = next;
          body = [];
          title = [];
        }
        if (field !== "title")
          for (const pos of p.phrase(row, 0, plan.ids, plan.at).starts)
            body.push(pos);
        if (field !== "body")
          for (const pos of p.phrase(row, 1, plan.ids, plan.at).starts)
            title.push(pos);
        if (body.length + title.length > 262144)
          throw new QueryResourceError("Positional span limit exceeded");
      }
      if (docs.length >= 128) yield emit();
      at += length;
    }
    carry = raw.slice(at);
    if (carry.length >= 65536) throw Error("Unbounded exact phrase carry");
  }
  if (carry.length) throw Error("Truncated exact phrase stream");
  if (doc >= 0) append();
  if (docs.length) yield emit();
}
class PhraseStream {
  private current?: IteratorResult<MatchBatch>;
  private row = 0;
  private iterator: AsyncGenerator<MatchBatch>;
  private docs = EMPTY;
  private offsets = [Uint32Array.of(0), Uint32Array.of(0)];
  private starts = [EMPTY, EMPTY];
  constructor(
    readonly plan: ExactPhrasePlan,
    readonly reader: Reader,
    field: "all" | "body" | "title",
  ) {
    this.iterator = matches(plan, reader, field);
  }
  async window(lo: number, hi: number) {
    const docs: number[] = [],
      offsets = [[0], [0]],
      starts: number[][] = [[], []];
    this.current ??= await this.iterator.next();
    while (!this.current.done) {
      const m = this.current.value;
      if (m.docs[this.row] >= hi) break;
      if (m.docs[this.row] >= lo) {
        docs.push(m.docs[this.row]);
        for (const f of [0, 1]) {
          for (
            let j = m.offsets[f][this.row];
            j < m.offsets[f][this.row + 1];
            j++
          )
            starts[f].push(m.starts[f][j]);
          offsets[f].push(starts[f].length);
        }
      }
      if (++this.row === m.docs.length) {
        this.current = await this.iterator.next();
        this.row = 0;
      }
    }
    this.docs = Uint32Array.from(docs);
    this.offsets = offsets.map((a) => Uint32Array.from(a));
    this.starts = starts.map((a) => Uint32Array.from(a));
    this.reader.stats.exactPhraseMatches += docs.length;
  }
  positions(doc: number, f: number) {
    const row = lower(this.docs, doc);
    return this.docs[row] === doc
      ? this.starts[f].subarray(this.offsets[f][row], this.offsets[f][row + 1])
      : EMPTY;
  }
  get bytes() {
    return (
      this.docs.byteLength +
      this.offsets.reduce((n, a) => n + a.byteLength, 0) +
      this.starts.reduce((n, a) => n + a.byteLength, 0)
    );
  }
  presence(lo: number, size: number, field: "all" | "body" | "title") {
    const mask = new Uint8Array(size);
    for (let row = 0; row < this.docs.length; row++)
      if (
        (field !== "title" &&
          this.offsets[0][row + 1] > this.offsets[0][row]) ||
        (field !== "body" && this.offsets[1][row + 1] > this.offsets[1][row])
      )
        mask[this.docs[row] - lo] = 1;
    return mask;
  }
}
export class ExactPhraseExecution {
  private streams = new Map<string, PhraseStream>();
  private keys = new WeakMap<string[], string>();
  private lo = -1;
  private hi = -1;
  constructor(
    readonly plans: ExactPhrasePlan[],
    readonly reader: Reader,
    field: "all" | "body" | "title",
  ) {
    for (const p of plans)
      this.streams.set(p.words.join("\0"), new PhraseStream(p, reader, field));
  }
  private key = (words: string[]) => {
    let key = this.keys.get(words);
    if (key === undefined) {
      key = words.join("\0");
      this.keys.set(words, key);
    }
    return key;
  };
  covered = (words: string[]) => this.streams.has(this.key(words));
  evidence = (
    words: string[],
    doc: number,
    f: number,
  ): Uint32Array | undefined => {
    const s = this.streams.get(this.key(words));
    if (!s) return;
    if (doc < this.lo || doc >= this.hi)
      throw Error("Phrase evidence outside active window");
    return s.positions(doc, f);
  };
  async window(lo: number, hi: number) {
    if (this.lo === lo && this.hi === hi) return;
    this.lo = lo;
    this.hi = hi;
    await Promise.all([...this.streams.values()].map((s) => s.window(lo, hi)));
    this.reader.stats.peakExactPhraseBufferBytes = Math.max(
      this.reader.stats.peakExactPhraseBufferBytes,
      [...this.streams.values()].reduce((n, s) => n + s.bytes + 6 * 262144, 0),
    );
  }
  /** Numeric truth columns avoid a binary search, subarray and closure per
   * possible document. Unknown branches retain complete Boolean coverage. */
  mask(ast: Node, field: "all" | "body" | "title") {
    const size = this.hi - this.lo,
      cache = new Map<string, Uint8Array>();
    type Truth = number | Uint8Array;
    const at = (t: Truth, i: number) => (typeof t === "number" ? t : t[i]);
    const visit = (n: Node): Truth => {
      if (n.kind === "empty") return 0;
      if (n.kind === "all") return 1;
      if (n.kind === "term") return 2;
      if (n.kind === "phrase") {
        const key = this.key(n.terms),
          s = this.streams.get(key);
        if (!s) return 2;
        let a = cache.get(key);
        if (!a) {
          a = s.presence(this.lo, size, field);
          cache.set(key, a);
        }
        return a;
      }
      if (n.kind === "not") {
        const a = visit(n.child);
        if (typeof a === "number") return a === 2 ? 2 : 1 - a;
        return a.map((v) => (v === 2 ? 2 : 1 - v));
      }
      const a = visit(n.left),
        b = visit(n.right),
        out = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        const x = at(a, i),
          y = at(b, i);
        out[i] =
          n.kind === "or"
            ? x === 1 || y === 1
              ? 1
              : x === 0 && y === 0
                ? 0
                : 2
            : n.kind === "except"
              ? x === 0 || y === 1
                ? 0
                : x === 1 && y === 0
                  ? 1
                  : 2
              : x === 0 || y === 0
                ? 0
                : n.kind !== "near" && x === 1 && y === 1
                  ? 1
                  : 2;
      }
      return out;
    };
    const value = visit(ast);
    return typeof value === "number"
      ? new Uint8Array(size).fill(value === 0 ? 0 : 1)
      : value.map((v) => (v === 0 ? 0 : 1));
  }
}
