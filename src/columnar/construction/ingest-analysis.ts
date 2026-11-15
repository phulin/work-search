import {
  normalizeTerm,
  ENGLISH_ANALYSIS,
  type Analysis,
} from "../../query/analysis.js";

/** Ingestion needs token ordinals, not display spans. Cache only pure stemming
 * results, within one request, and detach retained keys from source strings. */
export function ingestAnalyzer(
  analysis?: Analysis,
  byteBudget = 2 * 1048576,
  entryLimit = 16384,
) {
  if (analysis !== undefined && analysis !== ENGLISH_ANALYSIS)
    throw Error("Unknown index analysis");
  const cache = new Map<string, { value: string; bytes: number }>();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const stats = {
    tokens: 0,
    stemCalls: 0,
    cacheHits: 0,
    cacheBytes: 0,
    maxCacheBytes: 0,
  };
  function word(value: string) {
    if (analysis === undefined) return value;
    const hit = cache.get(value);
    if (hit) {
      stats.cacheHits++;
      return hit.value;
    }
    stats.stemCalls++;
    const normalized = normalizeTerm(value, analysis);
    const bytes = 96 + (value.length + normalized.length) * 2;
    if (value.length <= 96 && bytes <= byteBudget && entryLimit > 0) {
      while (
        cache.size &&
        (stats.cacheBytes + bytes > byteBudget || cache.size >= entryLimit)
      ) {
        const first = cache.keys().next().value!;
        stats.cacheBytes -= cache.get(first)!.bytes;
        cache.delete(first);
      }
      const key = decoder.decode(encoder.encode(value));
      cache.set(key, {
        value:
          normalized === value
            ? key
            : decoder.decode(encoder.encode(normalized)),
        bytes,
      });
      stats.cacheBytes += bytes;
      stats.maxCacheBytes = Math.max(stats.maxCacheBytes, stats.cacheBytes);
    }
    return normalized;
  }
  return {
    stats,
    scan(text: string, accept: (word: string, position: number) => void) {
      let position = 0;
      for (const match of text
        .normalize("NFKC")
        .toLowerCase()
        .matchAll(/[\p{L}\p{N}]+/gu))
        accept(word(match[0]), position++);
      stats.tokens += position;
      return position;
    },
  };
}
