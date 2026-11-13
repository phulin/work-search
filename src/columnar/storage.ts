import { crc32 } from "../format/codec.js";
import { DocumentPackage } from "./document-package.js";
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
  readWhole?(
    key: string,
    range?: { offset: number; length: number; doc: number; first: number },
  ): Promise<{ data: Uint8Array; sha256?: string; checksum?: number }>;
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
    forwardIntegers: 0,
    postings: 0,
    candidates: 0,
    skippedRanges: 0,
    metadataMs: 0,
    resultRequests: 0,
    resultBytes: 0,
    resultSharedGets: 0,
    resultMemoryHits: 0,
    candidatePackageBytes: 0,
    inflatedBytes: 0,
    repeatedInflatedBytes: 0,
    activeBufferBytes: 0,
    peakActiveBufferBytes: 0,
    peakPendingSharedBytes: 0,
    coalescedReads: 0,
    coalescedExtraBytes: 0,
  };
  seenDecoded = new Set<number>();
  seenInflated = new Set<number>();
  seenPackageSections = new Set<string>();
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
  /** A packet is a transfer unit, independent of the 256-KiB cache pages.
   * Fetch a contiguous miss span once, validate each page, and populate the
   * ordinary page cache. Cached pages inside that span may be read again to
   * avoid another GET. Their extra bytes are reported separately. */
  async packet(ref: Ref): Promise<Uint8Array> {
    const key = "packet:" + this.key(ref),
      pending = this.pending.get(key);
    if (pending) {
      this.stats.deduplicated++;
      return pending;
    }
    const task = this.readPacket(ref);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  private async readPacket(ref: Ref): Promise<Uint8Array> {
    const [object, offset, length] = ref,
      descriptor = objectAt(this.root, object);
    if (
      !descriptor ||
      offset < 0 ||
      length < 1 ||
      offset + length > descriptor.size
    )
      throw Error("Invalid packet reference");
    if (!descriptor.checksums || length > 8 * 1048576) return this.read(ref);
    const first = Math.floor(offset / PAGE),
      last = Math.floor((offset + length - 1) / PAGE),
      indices = Array.from({ length: last - first + 1 }, (_, i) => first + i),
      key = (page: number) =>
        `${this.root.generation}/${this.namespace}/${object}/${page}`;
    const pages = await Promise.all(
      indices.map(async (page) => {
        const k = key(page),
          hit = this.memory.pages.get(k);
        if (hit) {
          this.stats.memoryHits++;
          return hit;
        }
        const pending = this.pending.get(k);
        if (pending) {
          this.stats.deduplicated++;
          return pending;
        }
        if (this.shared) {
          this.stats.sharedGets++;
          const data = await this.io.run(() => this.shared!.get(k));
          if (data) {
            this.memory.pages.set(k, data, data.length);
            return data;
          }
        }
        return undefined;
      }),
    );
    const missing = indices.filter((_, i) => !pages[i]);
    if (missing.length) {
      const from = missing[0],
        to = missing.at(-1)!,
        start = from * PAGE,
        bytes = Math.min(descriptor.size, (to + 1) * PAGE) - start;
      this.stats.coalescedReads++;
      this.stats.requests++;
      this.stats.bytes += bytes;
      this.stats.coalescedExtraBytes += indices.reduce(
        (n, p, i) =>
          n + (p >= from && p <= to && pages[i] ? pages[i]!.length : 0),
        0,
      );
      const task = this.io.run(async () => {
        const data = await this.source.read(
          descriptor.key ?? `${this.root.generation}/${descriptor.name}`,
          start,
          bytes,
        );
        if (data.length !== bytes) throw Error("Truncated packet range");
        const result: Uint8Array[] = [];
        for (let page = from; page <= to; page++) {
          const raw = data.subarray(
            (page - from) * PAGE,
            Math.min(data.length, (page - from + 1) * PAGE),
          );
          if (crc32(raw) !== descriptor.checksums![page])
            throw Error("Immutable packet checksum mismatch");
          // Each page owns its storage: evicting one page must not retain an
          // entire multi-megabyte range through another page's subarray.
          const owned = Uint8Array.from(raw),
            k = key(page);
          result.push(owned);
          this.memory.pages.set(k, owned, owned.length);
          if (this.shared) {
            while (this.sharedWriteBytes >= 2 * 1048576)
              await Promise.race(this.sharedWrites);
            this.stats.sharedPuts++;
            this.sharedWriteBytes += owned.length;
            this.stats.peakPendingSharedBytes = Math.max(
              this.stats.peakPendingSharedBytes,
              this.sharedWriteBytes,
            );
            const write = this.shared
              .put(k, owned)
              .catch(() => {})
              .finally(() => {
                this.sharedWriteBytes -= owned.length;
                this.sharedWrites.delete(write);
              });
            this.sharedWrites.add(write);
            this.defer(write);
          }
        }
        return result;
      });
      for (let page = from; page <= to; page++) {
        const p = task.then((data) => data[page - from]);
        void p.catch(() => {});
        this.pending.set(key(page), p);
      }
      try {
        const fetched = await task;
        for (let page = from; page <= to; page++)
          pages[page - first] = fetched[page - from];
      } finally {
        for (let page = from; page <= to; page++)
          this.pending.delete(key(page));
      }
    }
    const data = pages.length === 1 ? pages[0]! : concat(pages as Uint8Array[]);
    return data.subarray(offset % PAGE, (offset % PAGE) + length);
  }
  async packets(refs: Ref[]) {
    this.stats.stages++;
    const groups: { ref: Ref; entries: { ref: Ref; index: number }[] }[] = [];
    for (const entry of refs
      .map((ref, index) => ({ ref, index }))
      .sort((a, b) => a.ref[0] - b.ref[0] || a.ref[1] - b.ref[1])) {
      const group = groups.at(-1),
        end = entry.ref[1] + entry.ref[2];
      if (
        group &&
        group.ref[0] === entry.ref[0] &&
        entry.ref[1] <= group.ref[1] + group.ref[2] + PAGE &&
        Math.max(group.ref[1] + group.ref[2], end) - group.ref[1] <= 8 * 1048576
      ) {
        group.ref[2] =
          Math.max(group.ref[1] + group.ref[2], end) - group.ref[1];
        group.entries.push(entry);
      } else groups.push({ ref: [...entry.ref], entries: [entry] });
    }
    const result: Uint8Array[] = new Array(refs.length);
    await Promise.all(
      groups.map(async (group) => {
        const data = await this.packet(group.ref);
        for (const { ref, index } of group.entries)
          result[index] = data.subarray(
            ref[1] - group.ref[1],
            ref[1] - group.ref[1] + ref[2],
          );
      }),
    );
    return result;
  }
  async document(
    generation: string,
    doc: number,
    locator?: { key: string; offset: number; length: number; first: number },
  ) {
    if (
      !Number.isInteger(doc) ||
      doc < 0 ||
      !/^[a-f0-9]{64}$/.test(generation) ||
      !this.source.readWhole
    )
      throw Error("Invalid document package source");
    const address = locator?.key ?? `${generation}/plan-${doc}.bin`,
      key = `${this.root.generation}/${this.namespace}/whole/${generation}/${doc}`;
    const decoded = (raw: Uint8Array) =>
      new DocumentPackage(raw, doc, (kind, section, n) => {
        const id = `${address}:${doc}:${kind}:${section}`;
        if (kind === "tokens") this.stats.forwardIntegers += n;
        else if (kind === "decoded") {
          this.stats.decodedBytes += n;
          if (this.seenPackageSections.has(id))
            this.stats.repeatedDecodedBytes += n;
        } else {
          this.stats.inflatedBytes += n;
          if (this.seenPackageSections.has(id))
            this.stats.repeatedInflatedBytes += n;
        }
        this.seenPackageSections.add(id);
      });
    let bytes = this.memory.pages.get(key);
    if (bytes) {
      this.stats.memoryHits++;
      return decoded(bytes);
    }
    const old = this.pending.get(key);
    if (old) {
      this.stats.deduplicated++;
      return decoded(await old);
    }
    const task = this.io.run(async () => {
      if (this.shared) {
        this.stats.sharedGets++;
        const data = await this.shared.get(key);
        if (data) {
          this.memory.pages.set(key, data, data.length);
          return data;
        }
      }
      const result = await this.source.readWhole!(
        address,
        locator ? { ...locator, doc } : undefined,
      );
      this.stats.requests++;
      this.stats.bytes += result.data.length;
      const digest = result.sha256
        ? [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                result.data as BufferSource,
              ),
            ),
          ]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("")
        : undefined;
      if (
        result.sha256
          ? digest !== result.sha256
          : result.checksum === undefined ||
            crc32(result.data) !== result.checksum
      )
        throw Error("Document package digest mismatch");
      this.memory.pages.set(key, result.data, result.data.length);
      if (this.shared && result.data.length <= 2 * 1048576) {
        while (this.sharedWriteBytes >= 2 * 1048576)
          await Promise.race(this.sharedWrites);
        this.stats.sharedPuts++;
        this.sharedWriteBytes += result.data.length;
        this.stats.peakPendingSharedBytes = Math.max(
          this.stats.peakPendingSharedBytes,
          this.sharedWriteBytes,
        );
        const write = this.shared
          .put(key, result.data)
          .catch(() => {})
          .finally(() => {
            this.sharedWriteBytes -= result.data.length;
            this.sharedWrites.delete(write);
          });
        this.sharedWrites.add(write);
        this.defer(write);
      }
      return result.data;
    });
    this.pending.set(key, task);
    try {
      bytes = await task;
      return decoded(bytes);
    } finally {
      this.pending.delete(key);
    }
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
    tag = "",
  ): T {
    const key = tag + this.key(ref),
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
