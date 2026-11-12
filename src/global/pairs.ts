import type { PairCostModel } from "./pair-costs.js";
import {
  crc32,
  encoder,
  decoder,
  varint,
  readVarint,
} from "../format/codec.js";
import { Dictionary, type Root, type Address } from "./format.js";
import type { PageReader } from "./storage.js";
import type { Node } from "../query/parser.js";

/** Separate immutable namespace; the base bundles never grow. */
export interface PairRoot {
  version: 1;
  baseGeneration: string;
  sourceSha256: string;
  entryEncoding?: "binary-v2";
  root: Root;
  selection: {
    vocabulary: number;
    pairs: number;
    budgetBytes: number;
    minDf: number;
    inlineMaxDf?: number;
  };
}
export interface PairEntry {
  df: number;
  inlineDocs?: number[];
  blocks: { first: number; last: number; address: Address }[];
}
export const pairKey = (a: string, b: string) => a + "\0" + b;
export function encodePairDocs(docs: number[]) {
  const bytes: number[] = [];
  varint(bytes, docs.length);
  let previous = 0;
  for (const doc of docs) {
    varint(bytes, doc - previous);
    previous = doc;
  }
  return Uint8Array.from(bytes);
}
export function decodePairDocs(bytes: Uint8Array) {
  const p = { i: 0 },
    n = readVarint(bytes, p),
    docs: number[] = [];
  let doc = 0;
  for (let i = 0; i < n; i++) {
    const delta = readVarint(bytes, p);
    if (i && !delta) throw Error("Unsorted pair documents");
    doc += delta;
    docs.push(doc);
  }
  if (p.i !== bytes.length) throw Error("Trailing pair documents");
  return docs;
}
/** V2 stores tiny doclists directly in the remote dictionary, with no extra gzip frame/address. */
export function encodePairEntry(entry: PairEntry) {
  const out: number[] = [];
  for (const n of [2, entry.df, entry.inlineDocs ? 1 : 0]) varint(out, n);
  if (entry.inlineDocs)
    for (const byte of encodePairDocs(entry.inlineDocs)) out.push(byte);
  else {
    varint(out, entry.blocks.length);
    for (const block of entry.blocks)
      for (const n of [block.first, block.last, ...block.address])
        varint(out, n);
  }
  return Uint8Array.from(out);
}
export function decodePairEntry(bytes: Uint8Array): PairEntry {
  const p = { i: 0 };
  if (readVarint(bytes, p) !== 2) throw Error("Pair entry version mismatch");
  const df = readVarint(bytes, p),
    kind = readVarint(bytes, p);
  if (kind === 1) {
    const inlineDocs = decodePairDocs(bytes.subarray(p.i));
    if (inlineDocs.length !== df) throw Error("Pair inline count mismatch");
    return { df, inlineDocs, blocks: [] };
  }
  if (kind !== 0) throw Error("Pair entry kind mismatch");
  const blocks: PairEntry["blocks"] = [];
  for (let i = 0, n = readVarint(bytes, p); i < n; i++) {
    const first = readVarint(bytes, p),
      last = readVarint(bytes, p),
      address = Array.from({ length: 5 }, () =>
        readVarint(bytes, p),
      ) as Address;
    blocks.push({ first, last, address });
  }
  if (p.i !== bytes.length) throw Error("Trailing pair entry");
  return { df, blocks };
}
export function encodePairRoot(root: PairRoot) {
  const bytes = encoder.encode(JSON.stringify(root)),
    out = new Uint8Array(bytes.length + 8),
    v = new DataView(out.buffer);
  v.setUint32(0, 0x31524950, true);
  v.setUint32(4, crc32(bytes), true);
  out.set(bytes, 8);
  return out;
}
export function decodePairRoot(bytes: Uint8Array, base: Root): PairRoot {
  if (bytes.length < 8) throw Error("Truncated pair root");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    v.getUint32(0, true) !== 0x31524950 ||
    v.getUint32(4, true) !== crc32(bytes.subarray(8))
  )
    throw Error("Pair root checksum/version mismatch");
  const root: PairRoot = JSON.parse(decoder.decode(bytes.subarray(8)));
  if (root.entryEncoding !== undefined && root.entryEncoding !== "binary-v2")
    throw Error("Unsupported pair entry encoding");
  if (
    root.version !== 1 ||
    root.baseGeneration !== base.generation ||
    root.root.count !== base.count ||
    !/^[a-f0-9]{64}$/.test(root.root.generation)
  )
    throw Error("Pair/base generation mismatch");
  return root;
}

export class PairFilter {
  constructor(
    readonly manifest: PairRoot,
    readonly reader: PageReader,
    readonly maxCandidateDocs = 32768,
    readonly intersectPairs = false,
  ) {
    if (reader.root.generation !== manifest.root.generation)
      throw Error("Pair reader generation mismatch");
  }
  private page(key: string) {
    const pages = this.manifest.root.dictionary;
    let lo = 0,
      hi = pages.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (pages[m].last < key) lo = m + 1;
      else hi = m;
    }
    const page = pages[lo];
    return page && key >= page.first ? page : undefined;
  }
  /** Batch all independent phrase lookups, then all chosen postings, within fixed memory limits. */
  private async many(
    phrases: string[][],
    costs?: PairCostModel,
  ): Promise<(Set<number> | undefined)[]> {
    const phraseKeys = phrases.map((terms) => {
        const keys = [
          ...new Set(terms.slice(1).map((term, i) => pairKey(terms[i], term))),
        ];
        if (!costs) return keys;
        const df = Math.min(...terms.map((t) => costs.df(t) ?? Infinity));
        if (df <= 1024) return [];
        // Skip only individually known expensive pairs; unknowns remain eligible.
        return keys.filter((key) => {
          const upper = costs.upper(key);
          return (
            upper === undefined ||
            upper <= Math.min(this.maxCandidateDocs, (df * 3) / 4)
          );
        });
      }),
      pages = new Map<string, { address: Address; keys: Set<string> }>();
    for (const keys of phraseKeys)
      for (const key of keys) {
        const page = this.page(key);
        if (!page) continue;
        const id = page.address.join(":"),
          existing = pages.get(id);
        if (existing) existing.keys.add(key);
        else pages.set(id, { address: page.address, keys: new Set([key]) });
      }
    const entries = new Map<string, PairEntry>(),
      refs = [...pages.values()];
    for (let at = 0; at < refs.length; at += 32) {
      const batch = refs.slice(at, at + 32),
        payloads = await this.reader.readMany(
          batch.map((p) => p.address),
          "pair-dictionary",
        );
      for (let i = 0; i < batch.length; i++) {
        const dictionary = new Dictionary(payloads[i]);
        for (const key of batch[i].keys) {
          const value = dictionary.lookup(key);
          if (value)
            entries.set(
              key,
              this.manifest.entryEncoding === "binary-v2"
                ? decodePairEntry(value)
                : JSON.parse(decoder.decode(value)),
            );
        }
      }
    }
    const chosen = phraseKeys.map((keys, phraseIndex) => {
        const ranked = keys
          .map((key) => entries.get(key))
          .filter(
            (entry): entry is PairEntry =>
              !!entry &&
              (!costs ||
                entry.df <=
                  Math.min(
                    this.maxCandidateDocs,
                    (Math.min(
                      ...phrases[phraseIndex].map(
                        (t) => costs.df(t) ?? Infinity,
                      ),
                    ) *
                      3) /
                      4,
                  )),
          )
          .sort((a, b) => a.df - b.df);
        if (!this.intersectPairs) return ranked.slice(0, 1);
        // A tiny dictionary-resident anchor already bounds verification; avoid a remote posting stage.
        return ranked[0]?.inlineDocs
          ? ranked.filter((entry) => entry.inlineDocs)
          : ranked;
      }),
      primary = [...new Set(chosen.flatMap((list) => list.slice(0, 1)))].sort(
        (a, b) => a.df - b.df,
      ),
      all = [...new Set(chosen.flat())],
      extras = all
        .filter((entry) => !primary.includes(entry))
        .sort((a, b) => a.df - b.df),
      unique = [...primary, ...extras],
      selected = new Map<PairEntry, Set<number>>();
    let charge = 0;
    // Clause filters exceeding the aggregate cap become unknown, which is always conservative.
    for (const entry of unique)
      if (charge + entry.df <= this.maxCandidateDocs) {
        selected.set(entry, new Set(entry.inlineDocs));
        charge += entry.df;
      }
    const blocks = [...selected].flatMap(([entry]) =>
      entry.blocks.map((block) => ({ entry, address: block.address })),
    );
    for (let at = 0; at < blocks.length; at += 32) {
      const batch = blocks.slice(at, at + 32),
        payloads = await this.reader.readMany(
          batch.map((b) => b.address),
          "pair-candidates",
        );
      for (let i = 0; i < batch.length; i++)
        for (const doc of decodePairDocs(payloads[i]))
          selected.get(batch[i].entry)!.add(doc);
    }
    const ids = new Map(unique.map((entry, i) => [entry, i])),
      intersections = new Map<string, Set<number>>();
    return chosen.map((list) => {
      const available = list.filter((entry) => selected.has(entry));
      if (!available.length) return undefined;
      if (available.length === 1) return selected.get(available[0]);
      const key = available.map((entry) => ids.get(entry)).join(":");
      const existing = intersections.get(key);
      if (existing) return existing;
      let docs = new Set(selected.get(available[0])!);
      for (const entry of available.slice(1)) {
        const other = selected.get(entry)!;
        for (const doc of docs) if (!other.has(doc)) docs.delete(doc);
      }
      intersections.set(key, docs);
      return docs;
    });
  }
  /** Pair occurrence is a necessary condition; full exact phrase verification remains mandatory. */
  async candidates(terms: string[]): Promise<Set<number> | undefined> {
    return (await this.many([terms]))[0];
  }
  /** A complete superset for the whole AST; undefined means no safe pruning. */
  async queryCandidates(
    node: Node,
    costs?: PairCostModel,
  ): Promise<Set<number> | undefined> {
    const leaves: Extract<Node, { kind: "phrase" }>[] = [];
    const collect = (n: Node): void => {
      if (n.kind === "phrase") leaves.push(n);
      else if (n.kind === "except") collect(n.left);
      else if (n.kind === "and" || n.kind === "near" || n.kind === "or") {
        collect(n.left);
        collect(n.right);
      }
    };
    const filterable = (n: Node): boolean =>
      n.kind === "phrase" ||
      n.kind === "empty" ||
      (n.kind === "except" && filterable(n.left)) ||
      ((n.kind === "and" || n.kind === "near") &&
        (filterable(n.left) || filterable(n.right))) ||
      (n.kind === "or" && filterable(n.left) && filterable(n.right));
    if (costs && !filterable(node)) return undefined;
    collect(node);
    // Keep transient dictionaries and AST filter state bounded independently of query length.
    if (leaves.length > 32) return undefined;
    const sets = await this.many(
        leaves.map((leaf) => leaf.terms),
        costs,
      ),
      filters = new Map(leaves.map((leaf, i) => [leaf, sets[i]]));
    const combine = (n: Node): Set<number> | undefined => {
      if (n.kind === "empty") return new Set();
      if (n.kind === "phrase") return filters.get(n);
      if (n.kind === "except") return combine(n.left);
      if (n.kind === "and" || n.kind === "near" || n.kind === "or") {
        const left = combine(n.left),
          right = combine(n.right);
        if (n.kind === "or") {
          if (!left || !right) return undefined;
          const union = new Set(left);
          for (const doc of right) {
            union.add(doc);
            if (union.size > this.maxCandidateDocs) return undefined;
          }
          return union;
        }
        if (!left) return right;
        if (!right) return left;
        const smaller = left.size < right.size ? left : right,
          larger = smaller === left ? right : left;
        return new Set([...smaller].filter((doc) => larger.has(doc)));
      }
      return undefined;
    };
    return combine(node);
  }
  async predicate(node: Node): Promise<(doc: number) => boolean> {
    const docs = await this.queryCandidates(node);
    return docs ? (doc) => docs.has(doc) : () => true;
  }
}
