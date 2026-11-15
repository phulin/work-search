import { expect, it } from "vitest";
import { ingestAnalyzer } from "../src/columnar/construction/ingest-analysis.js";
import { scanText } from "../src/columnar/construction/text.js";
import { ENGLISH_ANALYSIS, tokenizerFor } from "../src/query/analysis.js";

it("preserves Unicode token identities and ordinals without computing display spans", () => {
  const texts = [
    "",
    "İ I i ı café CAFÉ ﬁ 𐐀 𐐨 法院 １２３",
    "running runs runner courts court’s",
    "Straße STRAẞE ΣΟΣ Σσς é e\u0301",
    "a".repeat(150),
    "\n court\t— court, judgment!",
  ];
  for (const analysis of [undefined, ENGLISH_ANALYSIS]) {
    const analyzer = ingestAnalyzer(analysis);
    for (let repetition = 0; repetition < 3; repetition++)
      for (const text of texts) {
        const actual: { word: string; position: number }[] = [];
        const count = analyzer.scan(text, (word, position) =>
          actual.push({ word, position }),
        );
        expect(actual).toEqual(
          [...scanText(text, analysis).tokens()].map(({ word, position }) => ({
            word,
            position,
          })),
        );
        expect(actual.map((t) => t.word)).toEqual(tokenizerFor(analysis)(text));
        expect(count).toBe(actual.length);
      }
  }
});

it("bounds the request's stemming cache and evicts without changing analysis", () => {
  const analyzer = ingestAnalyzer(ENGLISH_ANALYSIS, 512, 3);
  const texts = [
    "running running running",
    "court courts proven proving proof absent absence judge judgment testing tests",
    "running running running",
  ];
  for (const text of texts) {
    const actual: string[] = [];
    analyzer.scan(text, (word) => actual.push(word));
    expect(actual).toEqual(tokenizerFor(ENGLISH_ANALYSIS)(text));
  }
  expect(analyzer.stats.cacheHits).toBeGreaterThan(0);
  expect(analyzer.stats.maxCacheBytes).toBeLessThanOrEqual(512);
  expect(analyzer.stats.stemCalls + analyzer.stats.cacheHits).toBe(
    analyzer.stats.tokens,
  );
  const uncached = ingestAnalyzer(ENGLISH_ANALYSIS, 0, 0);
  uncached.scan("court court", () => {});
  expect(uncached.stats.cacheHits).toBe(0);
  expect(uncached.stats.cacheBytes).toBe(0);
});
