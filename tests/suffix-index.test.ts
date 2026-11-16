import { it, expect } from "vitest";
import { mkdtemp, open, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSuffixIndex } from "../scripts/suffix-builder.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { rankSuffix } from "../src/suffix/rank.js";
import {
  quantizer,
  quantize,
  scoreInterval,
  compareSuffix,
  documentSuffixRows,
  canonicalBit,
  SUFFIX_ROW_BYTES,
  quantizerForMaximum,
  type FixedScores,
} from "../src/suffix/format.js";
import { bm25 } from "../src/query/engine.js";
import type { NumericDocument } from "../src/columnar/construction/analyzed-document.js";

it("quantizes with conservative bounds and compares suffixes without crossing fields", () => {
  for (const bits of [8, 16] as const) {
    const q = quantizer(1000000, bits);
    for (let i = 0; i <= 10000; i++) {
      const score = (q.maximum * i) / 10000,
        interval = scoreInterval(quantize(score, q), q);
      expect(interval.lower).toBeLessThanOrEqual(score);
      expect(interval.upper).toBeGreaterThanOrEqual(score);
    }
  }
  const tokens = Uint32Array.of(1, 2, 0, 1, 2, 3, 0, 1, 2, 0);
  expect(compareSuffix(tokens, 0, 3)).toBeLessThan(0);
  expect(compareSuffix(tokens, 0, 7)).toBeLessThan(0);
});
it("scales common phrase scores to their block without losing exact staging inputs", () => {
  for (const bits of [8, 16] as const) {
    const q = quantizerForMaximum(0.003, bits),
      global = quantizer(1000000, bits);
    expect(q.step).toBeLessThan(global.step / 10000);
    for (const score of [0, 0.0000001, 0.00043, 0.0029, 0.003]) {
      const interval = scoreInterval(quantize(score, q), q);
      expect(interval.lower).toBeLessThanOrEqual(score);
      expect(interval.upper).toBeGreaterThanOrEqual(score);
    }
    expect(quantize(0, quantizerForMaximum(0, bits))).toBe(0);
  }
  const row: NumericDocument = {
      doc: 0,
      body: Uint32Array.of(1, 2, 1, 2),
      title: Uint32Array.of(1, 2),
    },
    stats: FixedScores = {
      count: 1000000,
      avgBody: 1000,
      avgTitle: 5,
      titleBoost: 2,
      df: Uint32Array.of(0, 999990, 999980),
    },
    raw = documentSuffixRows(row, 0, stats),
    v = new DataView(raw.buffer),
    exact = [1, 2].reduce(
      (score, id) =>
        score +
        bm25(2, stats.df[id], stats.count, 4, stats.avgBody) +
        2 * bm25(1, stats.df[id], stats.count, 2, stats.avgTitle),
      0,
    );
  expect(v.getFloat64(16, true)).toBeCloseTo(exact, 15);
  expect(v.getFloat64(16, true)).not.toBe(Math.fround(exact));
});
it("finds exhaustive phrase intervals, canonical field memberships and exact top-k for both quantizers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "word-suffix-"));
  try {
    const docs: NumericDocument[] = Array.from({ length: 90 }, (_, doc) => ({
        doc,
        body: Uint32Array.from([
          ...Array(40 + (doc % 4)).fill(1),
          2,
          256,
          3,
          doc % 2 ? 2 : 3,
          65536,
          1,
          2,
          ...Array(doc % 9).fill(2),
        ]),
        title: Uint32Array.from(doc % 3 ? [1, 2, 256, 3] : [2, 256, 1]),
      })),
      df = new Uint32Array(65537);
    for (const d of docs)
      for (const id of new Set([...d.body, ...d.title])) df[id]++;
    const stats: FixedScores = {
        count: docs.length,
        titleBoost: 2,
        avgBody: docs.reduce((n, d) => n + d.body.length, 0) / docs.length,
        avgTitle: docs.reduce((n, d) => n + d.title.length, 0) / docs.length,
        df,
      },
      manifest = await buildSuffixIndex(
        (async function* () {
          yield* docs;
        })(),
        stats,
        directory,
        "a".repeat(64),
        undefined,
        0.02,
      ),
      handles = new Map<string, ReturnType<typeof open>>(),
      reader = new SuffixReader(manifest, async (file, at, length) => {
        let h = handles.get(file);
        if (!h) handles.set(file, (h = open(directory + "/" + file, "r")));
        const b = Buffer.alloc(length);
        expect((await (await h).read(b, 0, length, at)).bytesRead).toBe(length);
        return b;
      });
    const matches = (tokens: Uint32Array, p: number[]) =>
      Array.from(tokens, (_, i) => i).filter(
        (i) =>
          i + p.length <= tokens.length &&
          p.every((id, j) => tokens[i + j] === id),
      );
    const phrases = [
      [1, 2],
      [2, 256],
      [256, 3],
      [3, 65536],
      [65536, 1],
      [2, 2],
      [3, 3],
      [1, 2, 256, 3],
      [1, 1, 1, 1, 1],
      [65536, 2],
      [256, 1, 1],
      Array(12).fill(1),
      [...Array(10).fill(1), 2],
    ];
    for (const p of phrases)
      for (const field of ["all", "body", "title"] as const) {
        const expected = docs
          .filter(
            (d) =>
              (field !== "title" && matches(d.body, p).length) ||
              (field !== "body" && matches(d.title, p).length),
          )
          .map((d) => d.doc);
        expect([
          ...(await reader.membership(Uint32Array.from(p), field)),
        ]).toEqual(expected);
      }
    const score = (doc: number, p: number[], field: string) => {
      const d = docs[doc];
      let score = 0;
      for (const id of new Set(p))
        score +=
          (field !== "title"
            ? bm25(
                d.body.filter((t) => t === id).length,
                df[id],
                stats.count,
                d.body.length,
                stats.avgBody,
              )
            : 0) +
          (field !== "body"
            ? 2 *
              bm25(
                d.title.filter((t) => t === id).length,
                df[id],
                stats.count,
                d.title.length,
                stats.avgTitle,
              )
            : 0);
      return score;
    };
    for (const p of phrases.filter((p) => p.length <= 5))
      for (const field of ["all", "body", "title"] as const)
        for (const bits of [8, 16] as const)
          for (const rangeMax of [false, true]) {
            const expected = docs
              .filter(
                (d) =>
                  (field !== "title" && matches(d.body, p).length) ||
                  (field !== "body" && matches(d.title, p).length),
              )
              .map((d) => ({ doc: d.doc, score: score(d.doc, p, field) }))
              .sort((a, b) => b.score - a.score || a.doc - b.doc);
            const run = async (after?: { doc: number; score: number }) =>
              rankSuffix(
                reader,
                Uint32Array.from(p),
                { bits, field, limit: 7, rangeMax, after },
                async (ids) =>
                  Float64Array.from(ids, (doc) => score(doc, p, field)),
              );
            const actual = await run();
            expect(actual.map((h) => h.doc)).toEqual(
              expected.slice(0, 7).map((h) => h.doc),
            );
            if (actual.length) {
              const after = actual.at(-1)!;
              expect((await run(after)).map((h) => h.doc)).toEqual(
                expected
                  .filter(
                    (h) =>
                      h.score < after.score ||
                      (h.score === after.score && h.doc > after.doc),
                  )
                  .slice(0, 7)
                  .map((h) => h.doc),
              );
            }
          }
    for (const h of handles.values()) await (await h).close();
    // Completed conversion can be resumed without rereading source documents.
    const resumed = await buildSuffixIndex(
      (async function* () {
        throw Error("Unexpected corpus reread");
        yield docs[0];
      })(),
      stats,
      directory,
      "a".repeat(64),
      undefined,
      0.02,
    );
    expect(resumed.generation).toBe(manifest.generation);
    expect(
      JSON.parse(await readFile(directory + "/construction.json", "utf8")).input
        .rows,
    ).toBe(manifest.rows);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("keeps distinct phrases canonical even when their routing hashes collide", () => {
  const body = Uint32Array.of(23833, 7, 65535, 32792, 39092, 65535, 23833, 7),
    title = Uint32Array.of(32792, 39092),
    df = new Uint32Array(65536);
  for (const id of [...body, ...title]) df[id] = 1;
  const bytes = documentSuffixRows({ doc: 0, body, title }, 0, {
      count: 1,
      avgBody: 8,
      avgTitle: 2,
      titleBoost: 2,
      df,
    }),
    v = new DataView(bytes.buffer),
    flags = (row: number) => v.getUint16(row * SUFFIX_ROW_BYTES + 12, true);
  expect(flags(0) & canonicalBit(2, "all")).not.toBe(0);
  expect(flags(3) & canonicalBit(2, "all")).not.toBe(0);
  expect(flags(6) & canonicalBit(2, "all")).toBe(0);
  expect(flags(8) & canonicalBit(2, "all")).toBe(0);
  expect(flags(8) & canonicalBit(2, "title")).not.toBe(0);
});
