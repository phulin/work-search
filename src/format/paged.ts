import { BinaryIndex, buildBinary, type Entry } from "./index.js";
import { DocumentTable, encodeDocuments } from "./documents.js";
import { crc32, encoder, decoder } from "./codec.js";
import { parallel, type Storage } from "../storage/types.js";
import { SearchRuntime } from "../query/runtime.js";
export const PAGED_MAGIC = 0x31504752;
export interface Page {
  first: string;
  offset: number;
  length: number;
  crc: number;
}
export interface Root {
  version: 1;
  generation: string;
  count: number;
  terms: number;
  avgBody: number;
  avgTitle: number;
  dictionary: Page[];
  norms: Page[];
  documents: Page[];
  dictionarySize: number;
  documentSize: number;
}
export function encodeRoot(root: Root) {
  const data = encoder.encode(JSON.stringify(root)),
    bytes = new Uint8Array(12 + data.length),
    v = new DataView(bytes.buffer);
  v.setUint32(0, PAGED_MAGIC, true);
  v.setUint32(4, data.length, true);
  v.setUint32(8, crc32(data), true);
  bytes.set(data, 12);
  return bytes;
}
export function decodeRoot(bytes: Uint8Array): Root {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 12 ||
    v.getUint32(0, true) !== PAGED_MAGIC ||
    v.getUint32(4, true) !== bytes.length - 12 ||
    crc32(bytes.subarray(12)) !== v.getUint32(8, true)
  )
    throw Error("Invalid paged root");
  const r: Root = JSON.parse(decoder.decode(bytes.subarray(12)));
  if (
    r.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(r.generation) ||
    !Number.isSafeInteger(r.count) ||
    r.count < 0 ||
    r.dictionarySize !== 256 ||
    r.documentSize !== 4096 ||
    r.norms.length !== Math.ceil(r.count / 4096) ||
    r.documents.length !== r.norms.length
  )
    throw Error("Paged version/geometry mismatch");
  for (const pages of [r.dictionary, r.norms, r.documents]) {
    let end = 0;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (
        !Number.isSafeInteger(p.offset) ||
        !Number.isSafeInteger(p.length) ||
        p.offset !== end ||
        p.length <= 0 ||
        (pages === r.dictionary && i > 0 && p.first <= pages[i - 1].first)
      )
        throw Error("Invalid page directory");
      end += p.length;
    }
  }
  return r;
}
export function openIndex(bytes: Uint8Array) {
  return bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) === PAGED_MAGIC
    ? new PagedIndex(bytes)
    : new BinaryIndex(bytes);
}
/** A fresh query view owns references; only verified page bytes enter the bounded shared LRU. */
export class PagedIndex extends BinaryIndex {
  override readonly paged = true;
  override readonly count: number;
  override readonly termCount: number;
  override readonly generation: string;
  override readonly avgBody: number;
  override readonly avgTitle: number;
  override readonly bytes: Uint8Array;
  readonly root: Root;
  readonly rootBytes: Uint8Array;
  private entries = new Map<string, Entry>();
  private normPages = new Map<number, DataView>();
  private docPages = new Map<number, DocumentTable>();
  private cache?: SearchRuntime;
  private storage?: Storage;
  pageRequests = 0;
  pageBytes = 0;
  constructor(bytes: Uint8Array) {
    const r = decodeRoot(bytes);
    super(
      buildBinary(
        r.generation,
        [],
        encodeDocuments([]),
        0,
        [],
        r.avgBody,
        r.avgTitle,
      ),
    );
    if (bytes.length > 8 * 1048576)
      throw Error("Paged routing root exceeds 8 MiB");
    this.bytes = bytes;
    this.root = r;
    this.rootBytes = bytes;
    this.count = r.count;
    this.termCount = r.terms;
    this.generation = r.generation;
    this.avgBody = r.avgBody;
    this.avgTitle = r.avgTitle;
  }
  override queryIndex() {
    return new PagedIndex(this.rootBytes);
  }
  private async page(
    kind: "dictionary" | "norms" | "documents",
    i: number,
    storage: Storage,
  ) {
    const p = this.root[kind][i];
    if (!p) throw Error("Page out of range");
    const key = JSON.stringify([this.generation, "page", kind, i, p.crc]);
    const cached = this.cache?.get<Uint8Array>(key);
    if (cached) return cached;
    const b = await storage.read(this.key(0, kind), p.offset, p.length);
    this.pageRequests++;
    this.pageBytes += b.length;
    if (b.length !== p.length || crc32(b) !== p.crc)
      throw Error("Page checksum mismatch");
    this.cache?.set(key, b, b.length);
    return b;
  }
  override async prepareTerms(
    terms: string[],
    storage: Storage,
    runtime?: SearchRuntime,
  ) {
    this.cache = runtime;
    this.storage = storage;
    const pages = new Set<number>();
    for (const t of terms) {
      let l = 0,
        r = this.root.dictionary.length;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (this.root.dictionary[m].first <= t) l = m + 1;
        else r = m;
      }
      if (l) pages.add(l - 1);
    }
    await parallel([...pages], 4, async (i) => {
      const index = new BinaryIndex(await this.page("dictionary", i, storage));
      if (index.generation !== this.generation)
        throw Error("Dictionary generation mismatch");
      for (const t of terms) {
        const e = index.lookup(t);
        if (e) this.entries.set(t, e);
      }
    });
  }
  override lookup(t: string) {
    return this.entries.get(t);
  }
  private async pages(
    kind: "norms" | "documents",
    ids: number[],
    storage: Storage,
  ) {
    const result = new Map<number, Uint8Array>(),
      missing: number[] = [];
    const key = (i: number) =>
      JSON.stringify([
        this.generation,
        "page",
        kind,
        i,
        this.root[kind][i].crc,
      ]);
    for (const i of ids.sort((a, b) => a - b)) {
      const b = this.cache?.get<Uint8Array>(key(i));
      if (b) result.set(i, b);
      else missing.push(i);
    }
    const groups: number[][] = [];
    for (const i of missing) {
      const g = groups[groups.length - 1],
        p = this.root[kind][i];
      if (g && p.offset + p.length - this.root[kind][g[0]].offset <= 262144)
        g.push(i);
      else groups.push([i]);
    }
    await parallel(groups, 4, async (group) => {
      const first = this.root[kind][group[0]],
        last = this.root[kind][group[group.length - 1]],
        length = last.offset + last.length - first.offset;
      const b = await storage.read(this.key(0, kind), first.offset, length);
      this.pageRequests++;
      this.pageBytes += b.length;
      if (b.length !== length) throw Error("Truncated page range");
      for (const i of group) {
        const p = this.root[kind][i],
          slice = b.slice(
            p.offset - first.offset,
            p.offset - first.offset + p.length,
          );
        if (crc32(slice) !== p.crc) throw Error("Page checksum mismatch");
        result.set(i, slice);
        this.cache?.set(key(i), slice, slice.length);
      }
    });
    return result;
  }
  override async prepareLengths(
    docs: Uint32Array,
    storage: Storage,
    additional: Uint32Array[] = [],
  ) {
    const ids = new Set<number>();
    for (const list of [docs, ...additional])
      for (const doc of list) ids.add(Math.floor(doc / 4096));
    if (ids.size * 32768 > 16 * 1048576)
      throw Error("Norm working set exceeds 16 MiB; refine query");
    for (const [i, b] of await this.pages("norms", [...ids], storage))
      this.normPages.set(i, new DataView(b.buffer, b.byteOffset, b.byteLength));
  }
  override hasLength(doc: number) {
    return this.normPages.has(Math.floor(doc / 4096));
  }
  override async ensureLengths(docs: Uint32Array) {
    const needed = new Set<number>();
    for (const d of docs)
      if (!this.hasLength(d)) needed.add(Math.floor(d / 4096));
    if (!needed.size) return;
    const ids = new Set<number>();
    for (const i of needed)
      for (let j = i; j < Math.min(this.root.norms.length, i + 4); j++)
        if (!this.normPages.has(j)) ids.add(j);
    if ((ids.size + this.normPages.size) * 32768 > 16 * 1048576)
      throw Error("Norm working set exceeds 16 MiB");
    for (const [i, b] of await this.pages("norms", [...ids], this.storage!))
      this.normPages.set(i, new DataView(b.buffer, b.byteOffset, b.byteLength));
  }
  override lengths(doc: number, out = { body: 0, title: 0 }) {
    const v = this.normPages.get(Math.floor(doc / 4096));
    if (!v) throw Error("Norm page not prepared");
    const p = (doc % 4096) * 8;
    out.body = v.getUint32(p, true);
    out.title = v.getUint32(p + 4, true);
    return out;
  }
  override async resolveDocuments(docs: number[], storage: Storage) {
    for (const [i, b] of await this.pages(
      "documents",
      [...new Set(docs.map((d) => Math.floor(d / 4096)))],
      storage,
    ))
      this.docPages.set(
        i,
        new DocumentTable(b, Math.min(4096, this.count - i * 4096)),
      );
  }
  override document(doc: number) {
    const p = this.docPages.get(Math.floor(doc / 4096));
    if (!p) throw Error("Document page not prepared");
    return p.document(doc % 4096);
  }
}
