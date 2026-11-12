import { QueryResourceError } from "../query/evaluate.js";
import { SearchRuntime } from "../query/runtime.js";
import { crc32 } from "../format/codec.js";
import { parallel, type Storage } from "../storage/types.js";
import { MAX_RAW, type Address, type Root } from "./format.js";
export const pageId = (root: Root, object: number, page: number) =>
  (Math.log2(root.pageBytes) - 16) * 2 ** 40 + object * root.objectPages + page;
export interface SharedPages {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
}
export interface ReadRound {
  stage: string;
  pages: number;
  requests: number;
  bytes: number;
  memoryHits: number;
  sharedHits: number;
  coalescedHits: number;
  startMs: number;
  endMs: number;
  ms: number;
}
export class PageReader {
  readonly rounds: ReadRound[] = [];
  private cacheLookups = 0;
  private cacheOperations = 0;
  private requests = 0;
  private traceStart = performance.now();
  private active = 0;
  private waiting: (() => void)[] = [];
  private pending = new Map<string, Promise<Uint8Array>>();
  private async origin(
    key: string,
    offset: number,
    length: number,
    round: ReadRound,
  ) {
    const id = key + ":" + offset + ":" + length;
    const existing = this.pending.get(id);
    if (existing) {
      round.coalescedHits++;
      return existing;
    }
    const task = (async () => {
      if (this.active >= 6)
        await new Promise<void>((r) => this.waiting.push(r));
      else this.active++;
      let body: Promise<Uint8Array>;
      try {
        if (++this.requests > 8000)
          throw new QueryResourceError(
            "Global storage request budget exceeded",
          );
        round.requests++;
        if (this.pipeline && this.source.open)
          body = (await this.source.open(key, offset, length)).bytes;
        else
          body = Promise.resolve(await this.source.read(key, offset, length));
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
      const bytes = await body;
      round.bytes += bytes.length;
      return bytes;
    })();
    this.pending.set(id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
  constructor(
    readonly root: Root,
    private source: Storage & {
      open?: (
        key: string,
        offset: number,
        length: number,
      ) => Promise<{ bytes: Promise<Uint8Array> }>;
    },
    readonly memory = new SearchRuntime(8 * 1048576),
    private shared?: SharedPages,
    private defer?: (task: Promise<unknown>) => void,
    private pipeline = true,
    private cachePolicy: "fixed384" | "adaptive960" = "adaptive960",
  ) {}
  clearTrace() {
    this.rounds.length = 0;
    this.requests = 0;
    this.cacheLookups = 0;
    this.cacheOperations = 0;
    this.traceStart = performance.now();
  }
  async readMany(refs: Address[], stage: string) {
    const start = performance.now(),
      pages = new Map<string, { object: number; page: number }>(),
      round: ReadRound = {
        stage,
        pages: 0,
        requests: 0,
        bytes: 0,
        memoryHits: 0,
        sharedHits: 0,
        coalescedHits: 0,
        startMs: start - this.traceStart,
        endMs: 0,
        ms: 0,
      };
    let expanded = 0;
    for (const [object, offset, length, , raw] of refs) {
      expanded += raw;
      if (expanded > 8 * 1048576)
        throw new QueryResourceError(
          "Global expanded batch exceeds memory budget",
        );
      if (
        !Number.isInteger(object) ||
        object < 0 ||
        object >= this.root.objects.length ||
        length < 1 ||
        raw > MAX_RAW ||
        offset + length > this.root.objects[object].size
      )
        throw Error("Invalid global address");
      for (
        let page = Math.floor(offset / this.root.pageBytes);
        page <= Math.floor((offset + length - 1) / this.root.pageBytes);
        page++
      )
        pages.set(`${object}:${page}`, { object, page });
    }
    if (pages.size * this.root.pageBytes > 16 * 1048576)
      throw Error("Global read batch exceeds memory budget");
    round.pages = pages.size;
    const loaded = new Map<string, Uint8Array>();
    await parallel(
      [...pages],
      this.pipeline ? Math.max(1, pages.size) : 6,
      async ([id, { object, page }]) => {
        const key = `${this.root.generation}/page-${pageId(this.root, object, page)}.bin`;
        let bytes = this.memory.get<Uint8Array>(key);
        if (bytes) round.memoryHits++;
        else {
          const shared =
            this.shared &&
            (this.cachePolicy === "fixed384"
              ? this.cacheLookups++ < 384
              : this.cacheOperations < 960)
              ? this.shared
              : undefined;
          if (shared) this.cacheOperations++;
          bytes = await shared?.get(key);
          if (bytes) round.sharedHits++;
          else {
            bytes = await this.origin(
              `${this.root.generation}/plan-${object}.bin`,
              page * this.root.pageBytes,
              Math.min(
                this.root.pageBytes,
                this.root.objects[object].size - page * this.root.pageBytes,
              ),
              round,
            );
            if (
              shared &&
              (this.cachePolicy === "fixed384" || this.cacheOperations < 960)
            ) {
              this.cacheOperations++;
              const p = shared.put(key, bytes);
              if (this.defer) this.defer(p);
              else await p;
            }
          }
          if (
            bytes.length !==
            Math.min(
              this.root.pageBytes,
              this.root.objects[object].size - page * this.root.pageBytes,
            )
          )
            throw Error("Truncated global page");
          this.memory.set(key, bytes, bytes.length);
        }
        loaded.set(id, bytes);
      },
    );
    const result = await parallel(
      refs,
      6,
      async ([object, offset, length, checksum, raw]) => {
        let compressed: Uint8Array;
        const page = Math.floor(offset / this.root.pageBytes),
          within = offset % this.root.pageBytes;
        if (within + length <= this.root.pageBytes)
          compressed = loaded
            .get(`${object}:${page}`)!
            .subarray(within, within + length);
        else {
          compressed = new Uint8Array(length);
          let at = 0;
          while (at < length) {
            const pos = offset + at,
              p = Math.floor(pos / this.root.pageBytes),
              inside = pos % this.root.pageBytes,
              n = Math.min(length - at, this.root.pageBytes - inside);
            compressed.set(
              loaded.get(`${object}:${p}`)!.subarray(inside, inside + n),
              at,
            );
            at += n;
          }
        }
        if (crc32(compressed) !== checksum)
          throw Error("Global payload checksum mismatch");
        const reader = new Response(Uint8Array.from(compressed))
            .body!.pipeThrough(new DecompressionStream("gzip"))
            .getReader(),
          parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.length;
            if (size > raw || size > MAX_RAW)
              throw Error("Global expansion limit");
            parts.push(r.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (size !== raw) throw Error("Global payload length mismatch");
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const p of parts) {
          bytes.set(p, at);
          at += p.length;
        }
        return bytes;
      },
    );
    round.ms = performance.now() - start;
    round.endMs = performance.now() - this.traceStart;
    this.rounds.push(round);
    return result;
  }
}
export function workerPageCache(
  cache: Cache,
  origin: string,
  defer: (p: Promise<unknown>) => void,
): SharedPages {
  return {
    async get(key) {
      const r = await cache.match(new Request(origin + "/__index_page/" + key));
      return r ? new Uint8Array(await r.arrayBuffer()) : undefined;
    },
    async put(key, value) {
      const p = cache.put(
        new Request(origin + "/__index_page/" + key),
        new Response(Uint8Array.from(value), {
          headers: {
            "cache-control": "public,max-age=31536000,immutable",
            "content-type": "application/octet-stream",
            "content-length": String(value.length),
          },
        }),
      );
      defer(p);
    },
  };
}
// CDN mode is a distinct access path: deploy/upload immutable full page objects first.
export class HttpPageStorage implements Storage {
  constructor(
    private root: Root,
    private base: string,
  ) {}
  async open(key: string, offset: number, length: number) {
    if (!key.startsWith(this.root.generation + "/"))
      throw Error("HTTP generation mismatch");
    const object = Number(/plan-(\d+)\.bin$/.exec(key)?.[1]);
    if (
      offset % this.root.pageBytes ||
      length !==
        Math.min(
          this.root.pageBytes,
          this.root.objects[object]?.size - offset,
        ) ||
      !Number.isInteger(object)
    )
      throw Error("HTTP page geometry");
    const page = pageId(this.root, object, offset / this.root.pageBytes),
      r = await fetch(
        `${this.base.replace(/\/$/, "")}/${this.root.generation}/page-${page}.bin`,
        { cf: { cacheEverything: true, cacheTtl: 31536000 } },
      );
    if (!r.ok) throw Error("CDN index page unavailable " + r.status);
    return {
      bytes: r.arrayBuffer().then((buffer) => {
        const b = new Uint8Array(buffer);
        if (b.length !== length) throw Error("CDN page length");
        return b;
      }),
    };
  }
  async read(key: string, offset: number, length: number) {
    return (await this.open(key, offset, length)).bytes;
  }
}
