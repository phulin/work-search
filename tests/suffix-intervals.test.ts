import { expect, it } from "vitest";
import {
  encodePhraseIntervals,
  PhraseIntervals,
  type PhraseInterval,
} from "../src/suffix/intervals.js";
import { SuffixReader } from "../src/suffix/reader.js";
import type { SuffixManifest } from "../src/suffix/format.js";

it("looks up exact short phrases without treating uncovered prefixes as absent", async () => {
  const corpus = "b".repeat(64),
    rows = 900000,
    records: PhraseInterval[] = [];
  for (let a = 1; a < 70; a++)
    for (let n = 2; n <= 5; n++)
      records.push({
        words: [a, ...Array.from({ length: n - 1 }, (_, i) => i + 2)],
        first: a * 100 + n,
        end: a * 100 + n + 20,
      });
  const raw = encodePhraseIntervals(records.reverse(), corpus, rows),
    table = new PhraseIntervals(raw, corpus, rows);
  for (const r of records)
    expect(table.lookup(Uint32Array.from(r.words))).toEqual({
      first: r.first,
      end: r.end,
    });
  for (const phrase of [[1], [1, 2, 2], [700, 2], [1, 2, 3, 4, 5, 6], []])
    expect(table.lookup(Uint32Array.from(phrase))).toBeUndefined();
  const wide = [{ words: [0xfffffe, 0xffffff], first: rows - 1, end: rows }];
  expect(
    new PhraseIntervals(
      encodePhraseIntervals(wide, corpus, rows),
      corpus,
      rows,
    ).lookup(Uint32Array.from(wide[0].words)),
  ).toEqual({ first: rows - 1, end: rows });
  expect(() =>
    encodePhraseIntervals([records[0], records[0]], corpus, rows),
  ).toThrow("Invalid suffix phrase interval");
  expect(() => new PhraseIntervals(raw, "a".repeat(64), rows)).toThrow(
    "Invalid suffix phrase intervals",
  );
  expect(
    () => new PhraseIntervals(raw.subarray(0, raw.length - 1), corpus, rows),
  ).toThrow("Truncated suffix phrase intervals");
  const manifest: SuffixManifest = {
      format: "word-suffix-1",
      generation: "c".repeat(64),
      corpusGeneration: corpus,
      count: 1000,
      rows,
      fixed: { titleBoost: 2, avgBody: 1, avgTitle: 1 },
      files: {},
      directory: [
        {
          first: 0,
          end: rows,
          low: [1, 2],
          high: [70, 2],
          ref: { offset: 0, length: 100 },
        },
      ],
    },
    reader = new SuffixReader(
      manifest,
      async () => {
        throw Error("Unexpected interval discovery read");
      },
      undefined,
      { intervals: raw },
    ),
    expected = records[20],
    phrase = Uint32Array.from(expected.words),
    interval = await reader.shortInterval(phrase);
  expect([interval.first, interval.end]).toEqual([
    expected.first,
    expected.end,
  ]);
  expect(reader.minimumRows(phrase)).toBe(20);
  expect(reader.stats.reads).toBe(0);
  expect(reader.stats.boundaryWaves).toBe(0);
  expect(reader.stats.intervalHits).toBe(1);
});
