import { crc32, encoder, decoder } from "./codec.js";
import type { Entry } from "./index.js";
import { parallel } from "../storage/types.js";
import { SearchRuntime } from "../query/runtime.js";
import type { Node } from "../query/parser.js";
export const ROUTE_BUCKETS = 4096;
export const entryFields = [
  "format",
  "df",
  "object",
  "offset",
  "length",
  "crc",
  "positionObject",
  "positionOffset",
  "positionLength",
  "positionCrc",
] as const;
export function routeHash(term: string) {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++)
    h = Math.imul(h ^ term.charCodeAt(i), 16777619);
  return (h >>> 0) % ROUTE_BUCKETS;
}
export interface RoutesRoot {
  version: 1;
  generation: string;
  shards: Record<string, string>;
  hot: string[];
  pages: { object: number; offset: number; length: number; crc: number }[];
}
export function encodeRoutes(root: RoutesRoot) {
  const b = encoder.encode(JSON.stringify(root)),
    out = new Uint8Array(b.length + 12),
    v = new DataView(out.buffer);
  v.setUint32(0, 0x31545247, true);
  v.setUint32(4, b.length, true);
  v.setUint32(8, crc32(b), true);
  out.set(b, 12);
  return out;
}
export function decodeRoutes(b: Uint8Array): RoutesRoot | undefined {
  if (b.length === 4 && b.every((n) => !n)) return;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (
    b.length < 12 ||
    v.getUint32(0, true) !== 0x31545247 ||
    v.getUint32(4, true) !== b.length - 12 ||
    crc32(b.subarray(12)) !== v.getUint32(8, true)
  )
    throw Error("Invalid routing root");
  const r = JSON.parse(decoder.decode(b.subarray(12)));
  if (
    r.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(r.generation) ||
    r.pages.length !== ROUTE_BUCKETS ||
    Object.values(r.shards).some(
      (g) => typeof g !== "string" || !/^[a-f0-9]{64}$/.test(g),
    )
  )
    throw Error("Routing version/generation mismatch");
  return r;
}
export function encodeRoutePage(
  rows: { term: string; shard: number; entry: Entry }[],
) {
  let length = 4;
  const terms = rows.map((r) => encoder.encode(r.term));
  for (const t of terms) length += 8 + t.length + 40;
  const out = new Uint8Array(length),
    v = new DataView(out.buffer);
  v.setUint32(0, rows.length, true);
  let p = 4;
  rows.forEach((r, i) => {
    v.setUint32(p, terms[i].length, true);
    v.setUint32(p + 4, r.shard, true);
    p += 8;
    out.set(terms[i], p);
    p += terms[i].length;
    for (const f of entryFields) {
      v.setUint32(p, r.entry[f] ?? 0, true);
      p += 4;
    }
  });
  return out;
}
export function findRouteTerms(b: Uint8Array, wanted: Set<string>) {
  if (b.length < 4) throw Error("Truncated route page");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength),
    out: Record<string, Record<string, Entry>> = {};
  let p = 4;
  for (let i = 0, n = v.getUint32(0, true); i < n; i++) {
    if (p + 8 > b.length) throw Error("Truncated route row");
    const len = v.getUint32(p, true),
      shard = v.getUint32(p + 4, true);
    p += 8;
    if (p + len + 40 > b.length) throw Error("Truncated route entry");
    const term = decoder.decode(b.subarray(p, p + len));
    p += len;
    if (wanted.has(term)) {
      const e: any = { term };
      for (let j = 0; j < entryFields.length; j++)
        e[entryFields[j]] = v.getUint32(p + j * 4, true);
      (out[term] ??= {})[shard] = e;
    }
    p += 40;
  }
  if (p !== b.length) throw Error("Invalid route page length");
  return out;
}
export function possible(
  n: Node,
  entries: Record<string, Entry | null>,
): boolean {
  switch (n.kind) {
    case "empty":
      return false;
    case "all":
    case "not":
      return true;
    case "term":
      return !!entries[n.term];
    case "phrase":
      return n.terms.every((t) => !!entries[t]);
    case "or":
      return possible(n.left, entries) || possible(n.right, entries);
    case "except":
      return possible(n.left, entries);
    default:
      return possible(n.left, entries) && possible(n.right, entries);
  }
}
export class TermRoutes {
  readonly hot: Set<string>;
  private cache = new SearchRuntime(2 * 1048576);
  private termCache = new SearchRuntime(2 * 1048576);
  private pending = new Map<number, Promise<Uint8Array>>();
  constructor(readonly root: RoutesRoot) {
    this.hot = new Set(root.hot);
  }
  async lookup(bucket: R2Bucket, terms: string[]) {
    const out: Record<string, Record<string, Entry>> = Object.fromEntries(
      terms.map((t) => [t, {}]),
    );
    const missing = terms.filter((t) => {
      const e = this.termCache.get<Record<string, Entry>>(t);
      if (e) {
        out[t] = e;
        return false;
      }
      return true;
    });
    await parallel([...new Set(missing.map(routeHash))], 4, async (id) => {
      let b = this.cache.get<Uint8Array>(String(id));
      if (!b) {
        let task = this.pending.get(id);
        if (!task) {
          task = this.read(bucket, id);
          this.pending.set(id, task);
        }
        try {
          b = await task;
        } finally {
          this.pending.delete(id);
        }
        this.cache.set(String(id), b, b.length);
      }
      const wanted = missing.filter((t) => routeHash(t) === id);
      const found = findRouteTerms(b, new Set(wanted));
      for (const term of wanted) {
        out[term] = found[term] ?? {};
        this.termCache.set(
          term,
          out[term],
          Object.keys(out[term]).length * 512 + term.length * 2,
        );
      }
    });
    return out;
  }
  private async read(bucket: R2Bucket, id: number) {
    const p = this.root.pages[id];
    if (
      !Number.isSafeInteger(p.length) ||
      p.length < 1 ||
      p.length > 8 * 1048576
    )
      throw Error("Invalid routing page");
    const o = await bucket.get(
      `${this.root.generation}/routes-${p.object}.bin`,
      { range: { offset: p.offset, length: p.length } },
    );
    if (!o || o.customMetadata?.generation !== this.root.generation)
      throw Error("Routing generation mismatch");
    const compressed = new Uint8Array(await o.arrayBuffer());
    if (compressed.length !== p.length || crc32(compressed) !== p.crc)
      throw Error("Routing checksum mismatch");
    const reader = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"))
        .getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 8 * 1048576) {
        await reader.cancel();
        throw Error("Routing expansion limit");
      }
      parts.push(r.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  }
}
