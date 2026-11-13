import { crc32 } from "../format/codec.js";
import {
  PAGE,
  type Ref,
  type Root,
  concat,
  decodeBranches,
  objectAt,
} from "./format.js";
export class Lru<T> {
  entries = new Map<string, { value: T; size: number }>();
  bytes = 0;
  peak = 0;
  constructor(readonly limit: number) {}
  get(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }
  set(key: string, value: T, size: number) {
    size += key.length * 2 + 192;
    if (size > this.limit) return;
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.size;
      this.entries.delete(key);
    }
    while (this.bytes + size > this.limit) {
      const [k, e] = this.entries.entries().next().value!;
      this.entries.delete(k);
      this.bytes -= e.size;
    }
    this.entries.set(key, { value, size });
    this.bytes += size;
    this.peak = Math.max(this.peak, this.bytes);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.peak = 0;
  }
}
export class Semaphore {
  active = 0;
  waiting: (() => void)[] = [];
  constructor(readonly slots: number) {}
  async run<T>(f: () => Promise<T>) {
    if (this.active >= this.slots)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await f();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
// get() returns only immutable bytes previously validated by this reader and
// stored with its generation-scoped receipt. Treat this cache like validated
// memory, rather than repeating a JavaScript checksum after every cache hit.
export interface SharedPages {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
}
export class Memory {
  pages = new Lru<Uint8Array>(24 * 1048576);
  decoded = new Lru<unknown>(4 * 1048576);
  activeQueries = 0;
  clear() {
    this.pages.clear();
    this.decoded.clear();
  }
}
export interface Source {
  read(key: string, offset: number, length: number): Promise<Uint8Array>;
  readPage?(
    key: string,
    offset: number,
    length: number,
    expectedSha256?: string,
  ): Promise<{ data: Uint8Array; checksum?: number }>;
}
export class Reader {
  // I/O promises belong to their request context in workerd. Share validated
  // bytes across requests; deduplicate outstanding I/O within each request.
  pending = new Map<string, Promise<Uint8Array>>();
  io = new Semaphore(6);
  sharedWrites = new Set<Promise<void>>();
  sharedWriteBytes = 0;
  stats = {
    requests: 0,
    bytes: 0,
    sharedGets: 0,
    sharedPuts: 0,
    memoryHits: 0,
    deduplicated: 0,
    stages: 0,
    decodedBytes: 0,
    repeatedDecodedBytes: 0,
    positionIntegers: 0,
    postings: 0,
    candidates: 0,
    skippedRanges: 0,
    metadataMs: 0,
    inflatedBytes: 0,
    repeatedInflatedBytes: 0,
    activeBufferBytes: 0,
    peakActiveBufferBytes: 0,
    peakPendingSharedBytes: 0,
  };
  seenDecoded = new Set<number>();
  seenInflated = new Set<number>();
  constructor(
    readonly root: Pick<Root, "generation" | "objects" | "objectIds">,
    readonly source: Source,
    readonly memory = new Memory(),
    readonly shared?: SharedPages,
    readonly namespace = "default",
    readonly defer: (p: Promise<unknown>) => void = (p) => {
      void p.catch(() => {});
    },
  ) {}
  key(ref: Ref) {
    return `${this.root.generation}:${ref.join(":")}`;
  }
  async page(object: number, page: number) {
    const o = objectAt(this.root, object);
    if (!o) throw Error("Invalid object");
    const offset = page * PAGE,
      length = Math.min(PAGE, o.size - offset),
      key = `${this.root.generation}/${this.namespace}/${object}/${page}`;
    if (length <= 0) throw Error("Invalid page");
    const hit = this.memory.pages.get(key);
    if (hit) {
      this.stats.memoryHits++;
      return hit;
    }
    const pending = this.pending.get(key);
    if (pending) {
      this.stats.deduplicated++;
      return pending;
    }
    const task = this.io.run(async () => {
      let data: Uint8Array | undefined,
        origin = false,
        checksum = o.checksums?.[page];
      if (this.shared) {
        this.stats.sharedGets++;
        data = await this.shared.get(key);
      }
      if (!data) {
        origin = true;
        this.stats.requests++;
        this.stats.bytes += length;
        const key = o.key ?? `${this.root.generation}/${o.name}`;
        if (this.source.readPage) {
          const result = await this.source.readPage(
            key,
            offset,
            length,
            checksum === undefined ? o.sha256 : undefined,
          );
          data = result.data;
          checksum ??= result.checksum;
        } else data = await this.source.read(key, offset, length);
      }
      if (
        data.length !== length ||
        (origin && (checksum === undefined || crc32(data) !== checksum))
      )
        throw Error("Immutable page checksum mismatch");
      this.memory.pages.set(key, data, data.length);
      if (this.shared && origin) {
        // Cache writes retain their input until completion. Backpressure bounds
        // this separately from the page LRU, including concurrent fetches.
        while (this.sharedWriteBytes >= 2 * 1048576)
          await Promise.race(this.sharedWrites);
        this.stats.sharedPuts++;
        this.sharedWriteBytes += data.length;
        this.stats.peakPendingSharedBytes = Math.max(
          this.stats.peakPendingSharedBytes,
          this.sharedWriteBytes,
        );
        const size = data.length;
        const write = this.shared
          .put(key, data)
          .catch(() => {})
          .finally(() => {
            this.sharedWriteBytes -= size;
            this.sharedWrites.delete(write);
          });
        this.sharedWrites.add(write);
        this.defer(write);
      }
      return data;
    });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async read(ref: Ref) {
    const [object, offset, length] = ref,
      o = objectAt(this.root, object);
    if (
      !o ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      offset + length > o.size
    )
      throw Error("Invalid blob reference");
    const first = Math.floor(offset / PAGE),
      last = Math.floor((offset + length - 1) / PAGE);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) =>
        this.page(object, first + i),
      ),
    );
    if (parts.length === 1)
      return parts[0].subarray(offset % PAGE, (offset % PAGE) + length);
    return concat(parts).subarray(offset % PAGE, (offset % PAGE) + length);
  }
  async many(refs: Ref[]) {
    this.stats.stages++;
    return Promise.all(refs.map((r) => this.read(r)));
  }
  async load<T>(
    ref: Ref,
    decode: (data: Uint8Array) => T,
    charge?: number,
  ): Promise<T> {
    const old = this.memory.decoded.get(this.key(ref)) as T | undefined;
    if (old) {
      this.stats.memoryHits++;
      return old;
    }
    return this.decoded(ref, await this.read(ref), decode, charge);
  }
  decoded<T>(
    ref: Ref,
    data: Uint8Array,
    decode: (b: Uint8Array) => T,
    charge = data.length * 2,
  ): T {
    const key = this.key(ref),
      old = this.memory.decoded.get(key) as T | undefined;
    if (old) return old;
    this.stats.decodedBytes += data.length;
    const address = ref[0] * 64 * 1048576 + ref[1];
    if (this.seenDecoded.has(address))
      this.stats.repeatedDecodedBytes += data.length;
    this.seenDecoded.add(address);
    const value = decode(data);
    this.memory.decoded.set(key, value, charge);
    return value;
  }
  async branches(ref: Ref) {
    return this.load(ref, decodeBranches, ref[2] * 4);
  }
  async json(ref: Ref) {
    const key = "text:" + this.key(ref),
      old = this.memory.decoded.get(key);
    if (old) return old as any;
    const raw = new Response(
      (await this.read(ref)) as BodyInit,
    ).body!.pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(raw).text();
    if (text.length > 8 * 1048576) throw Error("Oversized text record");
    const address = ref[0] * 64 * 1048576 + ref[1];
    this.stats.inflatedBytes += text.length * 2;
    if (this.seenInflated.has(address))
      this.stats.repeatedInflatedBytes += text.length * 2;
    this.seenInflated.add(address);
    const value = JSON.parse(text);
    this.memory.decoded.set(key, value, text.length * 3);
    return value;
  }
}
