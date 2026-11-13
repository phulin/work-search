import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildColumnar } from "../bench/columnar/control/offline-build.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { ColumnarIndex, type Options } from "../src/columnar/search.js";
import { Reader } from "../src/columnar/storage.js";
import {
  essentialTerms,
  outward,
  cellBounds,
  deferScoreFetch,
} from "../src/columnar/maxscore.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { tokenize } from "../src/query/tokenize.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import type { Branch } from "../src/columnar/format.js";
const branch = (b: number, t = 0, count = 4096): Branch => ({
  first: 0,
  last: 4095,
  count,
  height: 0,
  b,
  t,
  score: [0, 0, 1],
  positions: [0, 0, 0],
  locators: [0, 0, 0],
});
it("keeps a provably sufficient essential union, ties, mandatory anchors and exact totals", () => {
  const blocks = [[branch(1)], [branch(2)], [branch(10)]];
  expect(
    essentialTerms(blocks, [1, 2, 10], [0, 1, 2], [], 4096, 4, false),
  ).toEqual([2]);
  expect(
    essentialTerms(blocks, [1, 2, 10], [0, 1, 2], [], 4096, 3, false),
  ).toEqual([1, 2]);
  expect(
    essentialTerms(blocks, [1, 2, 10], [0, 1, 2], [], 4096, undefined, false),
  ).toBeUndefined();
  expect(
    essentialTerms(blocks, [1, 2, 10], [0, 1, 2], [], 4096, 4, true),
  ).toBeUndefined();
  expect(
    essentialTerms(
      [[branch(10)], [branch(1, 0, 20)]],
      [10, 1],
      [0, 1],
      [1],
      4096,
      undefined,
      false,
    ),
  ).toEqual([1]);
  expect(
    cellBounds(
      [
        [
          { ...branch(1, 10), last: 3 },
          { ...branch(10, 1), first: 4 },
        ],
      ],
      0,
      128,
      "all",
      3,
    )[0][0],
  ).toBe(40);
  expect(outward(0, 100)).toBe(0);
  expect(outward(0.1 + 0.2, 100)).toBeGreaterThan(0.3);
  expect(deferScoreFetch(blocks, [2], 4096, () => false)).toBe(false);
  expect(deferScoreFetch(blocks, [2], 4096, () => true)).toBe(true);
  expect(deferScoreFetch(blocks, undefined, 4096, () => true)).toBe(false);
  expect(
    deferScoreFetch(
      [[{ ...branch(10, 0, 2) }], [{ ...branch(1), score: [0, 0, 262144] }]],
      [0],
      4096,
      () => false,
    ),
  ).toBe(true);
});
it("matches independent exhaustive ranks across lazy blocks, false positional leaders, fields, ties, totals and pagination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-maxscore-"));
  try {
    const docs = Array.from({ length: 32769 }, (_, i) => ({
      id: "d" + String(i).padStart(5, "0"),
      title: "common filler",
      body:
        i < 64
          ? "rare gap ".repeat(30) + "common filler"
          : i % 1024 === 0
            ? "rare common filler"
            : i % 1024 === 1
              ? "rare gap common filler"
              : "common filler " + (i % 7 ? "" : "gap"),
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const root = await buildColumnar({
        input: dir + "/input",
        out: dir + "/index",
      }),
      objects = new OfflineObjects(dir + "/index", root),
      index = new ColumnarIndex(root),
      tokens = docs.map((d) => [tokenize(d.body), tokenize(d.title)]),
      avgs = [0, 1].map(
        (f) => tokens.reduce((s, d) => s + d[f].length, 0) / docs.length,
      );
    try {
      let lazy = 0,
        rejected = 0,
        skipped = 0;
      const queries = [
        "rare OR common OR filler",
        "rare AND common",
        '"rare common"',
        '"rare rare"',
        "rare /3 common",
        'common NOT "rare common"',
        '(rare OR common) AND NOT "rare common"',
        '(rare OR "common filler") AND NOT "rare common"',
        "(rare OR common) AND NOT gap",
        '(rare NOT gap) OR (common NOT "rare common")',
        'NOT NOT "rare common"',
        '(rare OR common) OR NOT "gap filler"',
        '"rare common" OR filler',
        'NOT "rare common"',
      ];
      for (const q of queries)
        for (const field of ["all", "body", "title"] as const) {
          const ast = parse(q),
            positive = queryTerms(ast, true),
            dfs = positive.map(
              (t) => tokens.filter((d) => d.some((f) => f.includes(t))).length,
            ),
            boost = field === "title" ? 0 : 3.25;
          const expected = tokens
            .flatMap((fs, doc) => {
              if (
                !exhaustive(
                  ast,
                  field === "all" ? fs : [fs[field === "body" ? 0 : 1]],
                )
              )
                return [];
              let score = 0;
              for (let j = 0; j < positive.length; j++) {
                const perField = (f: number) => {
                  const tf = fs[f].filter((t) => t === positive[j]).length;
                  return tf
                    ? (Math.log((docs.length + 1) / (dfs[j] + 0.5)) *
                        tf *
                        2.2) /
                        (tf +
                          1.2 * (0.25 + (0.75 * fs[f].length) / (avgs[f] || 1)))
                    : 0;
                };
                score +=
                  (field !== "title" ? perField(0) : 0) +
                  (field !== "body" ? boost * perField(1) : 0);
              }
              return [{ id: docs[doc].id, doc, score }];
            })
            .sort((a, b) => b.score - a.score || a.doc - b.doc);
          const options: Options = {
              field,
              titleBoost: boost,
              limit: 7,
              metadata: false,
              snippets: false,
            },
            r = new Reader(root, objects.source),
            got = await index.search(q, r, options),
            full = await index.search(q, new Reader(root, objects.source), {
              ...options,
              exactTotal: true,
            });
          expect(
            got.results.map((h) => h.id),
            q + field,
          ).toEqual(expected.slice(0, 7).map((h) => h.id));
          expect(
            got.results.map((h) => [h.doc, h.score]),
            q + field + " exact score bits",
          ).toEqual(full.results.map((h) => [h.doc, h.score]));
          got.results.forEach((h, i) =>
            expect(h.score).toBeCloseTo(expected[i].score, 11),
          );
          expect(full.total, q + field).toBe(expected.length);
          expect(full.diagnostics.lazyScoreWindows).toBe(0);
          lazy += r.stats.lazyScoreWindows;
          rejected += r.stats.partialScoreRejected;
          skipped += r.stats.scoreBlocksFetched - r.stats.scoreBlocksDecoded;
          if (got.results.length) {
            const last = got.results.at(-1)!,
              after = { doc: last.doc, score: last.score },
              next = await index.search(q, new Reader(root, objects.source), {
                ...options,
                after,
              });
            expect(
              next.results.map((h) => h.id),
              q + field + " after",
            ).toEqual(expected.slice(7, 14).map((h) => h.id));
          }
        }
      expect(lazy).toBeGreaterThan(0);
      expect(rejected).toBeGreaterThan(0);
      expect(skipped).toBeGreaterThan(0);
    } finally {
      await objects.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
