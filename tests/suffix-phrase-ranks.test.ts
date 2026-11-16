import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSuffixIndex } from "../scripts/suffix-builder.js";
import { collectPhraseRanking } from "../scripts/suffix-phrase-ranking.js";
import { PhraseRanks, encodePhraseRanks } from "../src/suffix/phrase-ranks.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { rankSuffix } from "../src/suffix/rank.js";
import { contribution } from "../src/columnar/scoring.js";

it("builds conservative phrase rankings, answers covered top-k without suffix reads, and recovers deeper pages through the full index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suffix-phrase-ranks-"));
  try {
    const documents = Array.from({ length: 96 }, (_, doc) => ({
        doc,
        body: Uint32Array.from([
          ...Array.from({ length: 1 + (doc % 7) }, () => [1, 2]).flat(),
          ...Array(1 + doc * 2).fill(3),
        ]),
        title: Uint32Array.from(doc % 3 ? [1, 2] : [3]),
      })),
      stats = {
        count: documents.length,
        avgBody:
          documents.reduce((n, d) => n + d.body.length, 0) / documents.length,
        avgTitle:
          documents.reduce((n, d) => n + d.title.length, 0) / documents.length,
        titleBoost: 2,
        df: Uint32Array.of(0, 96, 96, 96),
      },
      generation = "a".repeat(64),
      manifest = await buildSuffixIndex(
        (async function* () {
          yield* documents;
        })(),
        stats,
        directory,
        generation,
      ),
      source = async (file: string, at: number, n: number) =>
        (await readFile(directory + "/" + file)).subarray(at, at + n),
      phrase = Uint32Array.of(1, 2),
      record = await collectPhraseRanking(
        new SuffixReader(manifest, source),
        phrase,
      ),
      idf = Math.log(1 + (stats.count - 96 + 0.5) / (96 + 0.5)),
      scores = Float64Array.from(documents, (d) =>
        [1, 2].reduce(
          (n, id) =>
            n +
            contribution(
              d.body.filter((x) => x === id).length,
              d.body.length,
              stats.avgBody,
              idf,
            ) +
            2 *
              contribution(
                d.title.filter((x) => x === id).length,
                d.title.length,
                stats.avgTitle,
                idf,
              ),
          0,
        ),
      ),
      expected = documents
        .map((d) => ({ doc: d.doc, score: scores[d.doc] }))
        .sort((a, b) => b.score - a.score || a.doc - b.doc),
      raw = encodePhraseRanks([record], generation, manifest.rows),
      kept = new Set(record.entries.map((e) => e.doc));
    for (const e of record.entries) {
      expect(scores[e.doc]).toBeGreaterThanOrEqual(e.lower);
      expect(scores[e.doc]).toBeLessThanOrEqual(e.upper);
    }
    for (const d of documents)
      if (!kept.has(d.doc))
        expect(scores[d.doc]).toBeLessThanOrEqual(record.tailUpper);
    expect(
      new PhraseRanks(raw, generation, manifest.rows, stats.count).lookup(
        phrase,
      )?.entries,
    ).toHaveLength(32);
    for (const limit of [1, 7, 20, 40]) {
      const reader = new SuffixReader(manifest, source, undefined, {
          phraseRanks: raw,
        }),
        actual = await rankSuffix(
          reader,
          phrase,
          { bits: 16, rangeMax: true, limit },
          async (docs) => Float64Array.from(docs, (d) => scores[d]),
        );
      expect(actual.map((h) => h.doc)).toEqual(
        expected.slice(0, limit).map((h) => h.doc),
      );
      if (limit <= 20) {
        expect(reader.stats.reads).toBe(0);
        expect(reader.stats.phraseRankHits).toBe(1);
      } else expect(reader.stats.reads).toBeGreaterThan(0);
    }
    const after = expected[39],
      reader = new SuffixReader(manifest, source, undefined, {
        phraseRanks: raw,
      }),
      page = await rankSuffix(
        reader,
        phrase,
        { bits: 8, rangeMax: true, limit: 10, after },
        async (docs) => Float64Array.from(docs, (d) => scores[d]),
      );
    expect(page.map((h) => h.doc)).toEqual(
      expected.slice(40, 50).map((h) => h.doc),
    );
    expect(reader.stats.phraseRankHits).toBe(0);
    expect(
      () => new PhraseRanks(raw, "b".repeat(64), manifest.rows, stats.count),
    ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("never uses an omitted-score bound to drop a possible tie", () => {
  const generation = "a".repeat(64),
    raw = encodePhraseRanks(
      [
        {
          words: [1, 2],
          entries: [{ doc: 0, position: 0, lower: 10, upper: 10 }],
          tailUpper: 10,
        },
      ],
      generation,
      20,
    ),
    ranks = new PhraseRanks(raw, generation, 20, 10);
  expect(ranks.lookup(Uint32Array.of(2, 1))).toBeUndefined();
  const reader = new SuffixReader(
    {
      format: "word-suffix-1",
      corpusGeneration: generation,
      rows: 20,
      count: 10,
      fixed: { titleBoost: 2 },
    } as any,
    async () => {
      throw Error("No I/O for proof selection");
    },
    undefined,
    { phraseRanks: raw },
  );
  expect(reader.phraseRanking(Uint32Array.of(1, 2), 1)).toBeUndefined();
});
