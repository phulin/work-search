import { tokenize } from "../query/tokenize.js";
import { SearchRuntime } from "../query/runtime.js";
import { crc32 } from "../format/codec.js";
export const FILTER_BYTES = 1024;
export const PASSAGE_RECORD = FILTER_BYTES + 24;
const words = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
export function fingerprint(term: string) {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++)
    h = Math.imul(h ^ term.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function filterTerm(filter: Uint8Array, term: string, add = false) {
  const h = fingerprint(term),
    step = (h >>> 16) | 1;
  for (let i = 0; i < 4; i++) {
    const bit = (h + Math.imul(i, step)) & (FILTER_BYTES * 8 - 1);
    if (add) filter[bit >>> 3] |= 1 << (bit & 7);
    else if (!(filter[bit >>> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}
export function* passageFrames(text: string) {
  let start = 0,
    filter = new Uint8Array(FILTER_BYTES);
  const frame = (end: number) => ({
    start,
    localStart: Math.min(160, start),
    coreLength: end - start,
    text: text.slice(Math.max(0, start - 160), end + 240),
    filter,
  });
  for (const m of text.matchAll(words)) {
    if (m.index! - start >= 8192) {
      yield frame(m.index!);
      start = m.index!;
      filter = new Uint8Array(FILTER_BYTES);
    }
    for (const term of tokenize(m[0])) filterTerm(filter, term, true);
  }
  yield frame(text.length);
}
export interface PassageAddress {
  generation: string;
  pointer: number[];
}
const caches = new WeakMap<R2Bucket, SearchRuntime>();
async function read(
  bucket: R2Bucket,
  address: PassageAddress,
  pointer: number[],
) {
  const key = address.generation + ":" + pointer.join(":");
  let cache = caches.get(bucket);
  if (!cache) caches.set(bucket, (cache = new SearchRuntime(2 * 1048576)));
  const cached = cache.get<Uint8Array>(key);
  if (cached) return cached;
  const [object, offset, length, checksum] = pointer;
  if (
    !/^[a-f0-9]{64}$/.test(address.generation) ||
    !length ||
    length > 4 * 1048576
  )
    throw Error("Invalid passage address");
  const o = await bucket.get(`${address.generation}/cards-${object}.bin`, {
    range: { offset, length },
  });
  if (!o || o.customMetadata?.generation !== address.generation)
    throw Error("Passage generation mismatch");
  const bytes = new Uint8Array(await o.arrayBuffer());
  if (bytes.length !== length || crc32(bytes) !== checksum)
    throw Error("Passage checksum mismatch");
  const reader = new Response(bytes)
    .body!.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 4 * 1048576) throw Error("Passage expansion limit");
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  cache.set(key, result, result.length);
  return result;
}
export async function passageExcerpt(
  bucket: R2Bucket,
  address: PassageAddress,
  terms: string[],
) {
  const directory = await read(bucket, address, address.pointer),
    v = new DataView(directory.buffer);
  if (
    directory.length < 8 ||
    v.getUint32(0, true) !== 0x31534750 ||
    directory.length !== 8 + v.getUint32(4, true) * PASSAGE_RECORD
  )
    throw Error("Invalid passage directory");
  const wanted = new Set(terms);
  let prefix = "";
  for (let i = 0; i < v.getUint32(4, true); i++) {
    const at = 8 + i * PASSAGE_RECORD,
      filter = directory.subarray(at + 24, at + PASSAGE_RECORD);
    if (!terms.some((t) => filterTerm(filter, t))) continue;
    const pointer = Array.from({ length: 4 }, (_, j) =>
      v.getUint32(at + j * 4, true),
    );
    const text = new TextDecoder().decode(await read(bucket, address, pointer));
    if (!i) prefix = text.slice(0, 400);
    if (!terms.some((t) => filterTerm(filter, t))) continue;
    const localStart = v.getUint32(at + 16, true),
      coreLength = v.getUint32(at + 20, true);
    for (const m of text.matchAll(words)) {
      if (m.index! < localStart || m.index! >= localStart + coreLength)
        continue;
      if (tokenize(m[0]).some((term) => wanted.has(term))) {
        const start = Math.max(0, m.index! - 160);
        return (
          (i || start ? "…" : "") +
          text.slice(start, m.index! + 240).trim() +
          "…"
        );
      }
    }
  }
  if (!prefix) {
    const pointer = Array.from({ length: 4 }, (_, j) =>
      v.getUint32(8 + j * 4, true),
    );
    prefix = new TextDecoder()
      .decode(await read(bucket, address, pointer))
      .slice(0, 400);
  }
  return (
    prefix.trim() +
    (v.getUint32(4, true) > 1 || prefix.length === 400 ? "…" : "")
  );
}
