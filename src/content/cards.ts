import { crc32 } from "../format/codec.js";
import { SearchRuntime } from "../query/runtime.js";
const MAGIC = 0x31445243,
  HEADER = 80,
  BLOCK = 128;
export interface ResultCard {
  doc: number;
  id: string;
  title?: string;
  metadata?: any;
  body: number[];
  passages?: number[];
  passageGeneration?: string;
}
const instances = new WeakMap<R2Bucket, ResultCards>();
const passageInstances = new WeakMap<R2Bucket, ResultCards>();
export function resultCards(bucket: R2Bucket, passages = false) {
  const registry = passages ? passageInstances : instances;
  let r = registry.get(bucket);
  if (!r) registry.set(bucket, (r = new ResultCards(bucket, passages)));
  return r;
}
export class ResultCards {
  private cache = new SearchRuntime(4 * 1048576);
  private loading = new Map<string, Promise<any>>();
  constructor(
    private bucket: R2Bucket,
    private passages = false,
  ) {}
  private async root(generation: string) {
    if (!/^[a-f0-9]{64}$/.test(generation))
      throw Error("Invalid card generation");
    const key = generation + ":root",
      cached = this.cache.get<any>(key);
    if (cached && (!cached.missing || cached.until > Date.now()))
      return cached.missing ? null : cached;
    if (this.loading.has(key)) return this.loading.get(key);
    const task = (async () => {
      const o = await this.bucket.get(
        generation + (this.passages ? "/passageroot-0.bin" : "/cardroot-0.bin"),
      );
      if (!o) {
        this.cache.set(key, { missing: true, until: Date.now() + 30000 }, 64);
        return null;
      }
      if (o.customMetadata?.generation !== generation)
        throw Error("Card root generation mismatch");
      const bytes = new Uint8Array(await o.arrayBuffer()),
        v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (
        bytes.length < HEADER ||
        v.getUint32(0, true) !== MAGIC ||
        v.getUint32(8, true) !== BLOCK
      )
        throw Error("Invalid card format");
      const count = v.getUint32(4, true),
        hex = (b: Uint8Array) =>
          Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      if (
        hex(bytes.subarray(16, 48)) !== generation ||
        bytes.length !== HEADER + Math.ceil(count / BLOCK) * 16 ||
        crc32(bytes.subarray(HEADER)) !== v.getUint32(12, true)
      )
        throw Error("Corrupt card directory");
      const value = {
        bytes,
        v,
        count,
        generation: hex(bytes.subarray(48, 80)),
      };
      this.cache.set(key, value, bytes.length + 256);
      return value;
    })();
    this.loading.set(key, task);
    try {
      return await task;
    } finally {
      this.loading.delete(key);
    }
  }
  async get(
    generation: string,
    doc: number,
    id: string,
  ): Promise<ResultCard | null> {
    if (!Number.isInteger(doc) || doc < 0) throw Error("Invalid card address");
    const key = generation + ":" + doc,
      cached = this.cache.get<ResultCard>(key);
    if (cached) {
      if (cached.id !== id) throw Error("Card identity mismatch");
      return cached;
    }
    const root = await this.root(generation);
    if (!root)
      return this.passages
        ? resultCards(this.bucket).get(generation, doc, id)
        : null;
    if (doc >= root.count) throw Error("Card document out of range");
    const p = HEADER + Math.floor(doc / BLOCK) * 16,
      obj = root.v.getUint32(p, true),
      offset = root.v.getUint32(p + 4, true),
      length = root.v.getUint32(p + 8, true),
      checksum = root.v.getUint32(p + 12, true);
    if (!length || length > 4 * 1048576) throw Error("Invalid card block size");
    const blockKey = key.split(":")[0] + ":block:" + Math.floor(doc / BLOCK);
    let task = this.loading.get(blockKey);
    if (!task) {
      task = (async () => {
        const o = await this.bucket.get(`${root.generation}/cards-${obj}.bin`, {
          range: { offset, length },
        });
        if (!o || o.customMetadata?.generation !== root.generation)
          throw Error("Card object generation mismatch");
        const b = new Uint8Array(await o.arrayBuffer());
        if (b.length !== length || crc32(b) !== checksum)
          throw Error("Card checksum mismatch");
        const reader = new Response(b)
            .body!.pipeThrough(new DecompressionStream("gzip"))
            .getReader(),
          decoder = new TextDecoder();
        let text = "",
          size = 0;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.length;
            if (size > 4 * 1048576) throw Error("Card expansion limit");
            text += decoder.decode(r.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
        const records = JSON.parse(text);
        if (!Array.isArray(records) || records.length > BLOCK)
          throw Error("Invalid card block");
        return records;
      })();
      this.loading.set(blockKey, task);
      task.finally(() => this.loading.delete(blockKey)).catch(() => {});
    }
    const records = await task,
      card = records[doc % BLOCK] as ResultCard;
    if (
      card?.doc !== doc ||
      card.id !== id ||
      !Array.isArray(card.body) ||
      card.body.length !== 4 ||
      card.body.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff)
    )
      throw Error("Card identity or pointer mismatch");
    if (card.passages) card.passageGeneration = root.generation;
    this.cache.set(key, card, JSON.stringify(card).length * 4 + 512);
    return card;
  }
}
