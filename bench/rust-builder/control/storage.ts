// Frozen CWS1 reader for builder verification only; not a production engine.
import { crc32 } from '../../../src/format/codec.js';
import { PAGE, type Ref, type Root, concat, decodeBranches } from './format.js';
export class Lru<T> {
  entries = new Map<string, { value: T; size: number }>(); bytes = 0; peak = 0;
  constructor(readonly limit: number) {}
  get(key: string) { const e = this.entries.get(key); if (!e) return; this.entries.delete(key); this.entries.set(key, e); return e.value; }
  set(key: string, value: T, size: number) {
    size += key.length * 2 + 192; if (size > this.limit) return;
    const old = this.entries.get(key); if (old) { this.bytes -= old.size; this.entries.delete(key); }
    while (this.bytes + size > this.limit) { const [k, e] = this.entries.entries().next().value!; this.entries.delete(k); this.bytes -= e.size; }
    this.entries.set(key, { value, size }); this.bytes += size; this.peak = Math.max(this.peak, this.bytes);
  }
  clear() { this.entries.clear(); this.bytes = 0; this.peak = 0; }
}
export class Semaphore {
  active = 0; waiting: (() => void)[] = [];
  constructor(readonly slots: number) {}
  async run<T>(f: () => Promise<T>) {
    if (this.active >= this.slots) await new Promise<void>(r => this.waiting.push(r)); else this.active++;
    try { return await f(); } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
export interface SharedPages { get(key: string): Promise<Uint8Array | undefined>; put(key: string, value: Uint8Array): Promise<void> }
export class Memory {
  pages = new Lru<Uint8Array>(24 * 1048576);
  decoded = new Lru<unknown>(4 * 1048576);
  pending = new Map<string, Promise<Uint8Array>>();
  io = new Semaphore(6); queries = new Semaphore(2);
  clear() { this.pages.clear(); this.decoded.clear(); }
}
export interface Source { read(key: string, offset: number, length: number): Promise<Uint8Array> }
export class Reader {
  stats = { requests: 0, bytes: 0, sharedGets: 0, sharedPuts: 0, memoryHits: 0, deduplicated: 0, stages: 0, decodedBytes: 0, repeatedDecodedBytes: 0, positionIntegers: 0, postings: 0, candidates: 0, skippedRanges: 0, metadataMs: 0, inflatedBytes: 0, repeatedInflatedBytes: 0, activeBufferBytes: 0, peakActiveBufferBytes: 0 };
  seenDecoded = new Set<string>(); seenInflated = new Set<string>();
  constructor(readonly root: Root, readonly source: Source, readonly memory = new Memory(), readonly shared?: SharedPages, readonly namespace = 'default', readonly defer: (p: Promise<unknown>) => void = p => { void p.catch(() => {}); }) {}
  key(ref: Ref) { return `${this.root.generation}:${ref.join(':')}`; }
  async page(object: number, page: number) {
    const o = this.root.objects[object]; if (!o) throw Error('Invalid object');
    const offset = page * PAGE, length = Math.min(PAGE, o.size - offset), key = `${this.root.generation}/${this.namespace}/${object}/${page}`;
    if (length <= 0) throw Error('Invalid page');
    const hit = this.memory.pages.get(key); if (hit) { this.stats.memoryHits++; return hit; }
    const pending = this.memory.pending.get(key); if (pending) { this.stats.deduplicated++; return pending; }
    const task = this.memory.io.run(async () => {
      let data: Uint8Array | undefined;
      if (this.shared) { this.stats.sharedGets++; data = await this.shared.get(key); }
      if (!data) { this.stats.requests++; this.stats.bytes += length; data = await this.source.read(`${this.root.generation}/${o.name}`, offset, length); }
      if (data.length !== length || crc32(data) !== o.checksums[page]) throw Error('Immutable page checksum mismatch');
      this.memory.pages.set(key, data, data.length);
      if (this.shared) { this.stats.sharedPuts++; this.defer(this.shared.put(key, data)); }
      return data;
    });
    this.memory.pending.set(key, task);
    try { return await task; } finally { this.memory.pending.delete(key); }
  }
  async read(ref: Ref) {
    const [object, offset, length] = ref, o = this.root.objects[object];
    if (!o || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > o.size) throw Error('Invalid blob reference');
    const first = Math.floor(offset / PAGE), last = Math.floor((offset + length - 1) / PAGE);
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.page(object, first + i)));
    if (parts.length === 1) return parts[0].subarray(offset % PAGE, (offset % PAGE) + length);
    return concat(parts).subarray(offset % PAGE, (offset % PAGE) + length);
  }
  async many(refs: Ref[]) { this.stats.stages++; return Promise.all(refs.map(r => this.read(r))); }
  decoded<T>(ref: Ref, data: Uint8Array, decode: (b: Uint8Array) => T, charge = data.length * 2): T {
    const key = this.key(ref), old = this.memory.decoded.get(key) as T | undefined; if (old) return old;
    this.stats.decodedBytes += data.length;
    if (this.seenDecoded.has(key)) this.stats.repeatedDecodedBytes += data.length; this.seenDecoded.add(key);
    const value = decode(data); this.memory.decoded.set(key, value, charge); return value;
  }
  async branches(ref: Ref) { return this.decoded(ref, await this.read(ref), decodeBranches, ref[2] * 4); }
  async json(ref: Ref) {
    const key = 'text:' + this.key(ref), old = this.memory.decoded.get(key); if (old) return old as any;
    const raw = new Response(await this.read(ref) as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(raw).text();
    if (text.length > 8 * 1048576) throw Error('Oversized text record');
    this.stats.inflatedBytes += text.length * 2; if (this.seenInflated.has(key)) this.stats.repeatedInflatedBytes += text.length * 2; this.seenInflated.add(key);
    const value = JSON.parse(text); this.memory.decoded.set(key, value, text.length * 3); return value;
  }
}
