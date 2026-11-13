import type { Root } from "./format.js";
import { view } from "./format.js";
import type { Reader } from "./storage.js";
import type { Options } from "./search.js";

export interface HeadRoot {
  format: "CWH1";
  baseGeneration: string;
  depth: number;
  // Each entry is an exhaustive top-depth certificate for this exact scoring
  // configuration. Other boosts and all cursors use the ordinary executor.
  entries: Record<
    string,
    {
      offset: number;
      length: number;
      count: number;
      text: number;
      textLength: number;
    }
  >;
}
export const headKey = (term: string, field: string, boost: number) =>
  JSON.stringify([term, field, field === "body" ? 0 : boost]);
export class Heads {
  constructor(
    readonly root: HeadRoot,
    readonly data: Uint8Array,
    base: Root,
  ) {
    if (root.format !== "CWH1" || root.baseGeneration !== base.generation)
      throw Error("Head generation mismatch");
  }
  async search(term: string, reader: Reader, options: Options) {
    if (
      !Number.isInteger(options.limit ?? 20) ||
      (options.limit ?? 20) < 1 ||
      !Number.isFinite(options.titleBoost ?? 2) ||
      (options.titleBoost ?? 2) < 0 ||
      (options.titleBoost ?? 2) > 20
    )
      return;
    if (
      options.after ||
      options.exactTotal ||
      (options.limit ?? 20) > this.root.depth
    )
      return;
    const key = headKey(term, options.field ?? "all", options.titleBoost ?? 2),
      entry = Object.hasOwn(this.root.entries, key)
        ? this.root.entries[key]
        : undefined;
    if (!entry) return;
    const n = Math.min(options.limit ?? 20, entry.count),
      v = view(this.data.subarray(entry.offset, entry.offset + entry.length));
    const cacheKey = "heads:" + this.root.baseGeneration + ":" + key;
    let text = reader.memory.decoded.get(cacheKey) as any[] | undefined;
    if (!text) {
      const stream = new Response(
        this.data.slice(entry.text, entry.text + entry.textLength) as BodyInit,
      ).body!.pipeThrough(new DecompressionStream("gzip"));
      const raw = await new Response(stream).text();
      reader.stats.inflatedBytes += raw.length * 2;
      text = JSON.parse(raw);
      if (!Array.isArray(text) || text.length !== entry.count)
        throw Error("Invalid head text");
      reader.memory.decoded.set(cacheKey, text, raw.length * 3);
    } else reader.stats.memoryHits++;
    return Array.from({ length: n }, (_, i) => ({
      id: text![i].id,
      doc: v.getUint32(i * 12, true),
      score: v.getFloat64(i * 12 + 4, true),
      ...(options.metadata !== false
        ? { title: text![i].title, metadata: text![i].metadata }
        : {}),
      ...(options.snippets !== false ? { snippet: text![i].snippet } : {}),
    }));
  }
}
