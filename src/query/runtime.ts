import type { DecodedPostings } from "../format/codec.js";
// Weighted LRU: charge retained typed buffers plus conservative per-entry and
// directory overhead. Oversized entries never enter the cache.
export class SearchRuntime {
  private values = new Map<string, { value: unknown; bytes: number }>();
  bytes = 0;
  private ceiling: number;
  constructor(readonly capacity = 4 * 1024 * 1024) {
    this.ceiling = capacity;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 0 ||
      capacity > 8 * 1024 * 1024
    )
      throw new Error("Invalid cache capacity");
  }
  get<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value as T;
  }
  set(key: string, value: unknown, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Invalid cache charge");
    const cost = bytes + key.length * 2 + 160;
    if (cost > this.ceiling) return;
    const previous = this.values.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.values.delete(key);
    }
    this.trimTo(this.ceiling - cost);
    this.values.set(key, { value, bytes: cost });
    this.bytes += cost;
  }
  trimTo(limit: number) {
    for (const [key, entry] of this.values) {
      if (this.bytes <= limit) break;
      this.values.delete(key);
      this.bytes -= entry.bytes;
    }
  }
  setLimit(limit: number) {
    this.ceiling = Math.max(0, Math.min(this.capacity, limit));
    this.trimTo(this.ceiling);
  }
  clear() {
    this.values.clear();
    this.bytes = 0;
  }
}
export function postingSize(l: DecodedPostings) {
  return (
    l.docs.byteLength +
    l.body.byteLength +
    l.title.byteLength +
    l.bytes.byteLength +
    (l.positionOffsets?.byteLength ?? 0) +
    (l.positionEnds?.byteLength ?? 0) +
    (l.blocks?.length ?? 0) * 128 +
    (l.blockRows?.byteLength ?? 0)
  );
}
