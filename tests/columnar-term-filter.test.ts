import { expect, it } from "vitest";
import { planTermFilter, readTermFilter } from "../src/columnar/term-filter.js";
import { encodeScores, type Root, type Ref } from "../src/columnar/format.js";
import type { DirectoryTerm } from "../src/columnar/term-directory.js";
import { Reader } from "../src/columnar/storage.js";
import { parse } from "../src/query/parser.js";

const root: Root = {
    format: "CWS1",
    generation: "a".repeat(64),
    corpusHash: "b".repeat(64),
    count: 1000000,
    avgBody: 10,
    avgTitle: 2,
    objects: [],
    documents: [],
    dictionaries: [],
    hot: {},
  },
  alternative = {
    kind: "blocks" as const,
    frequencyBytes: 64 * 1048576,
    positionBytes: 128 * 1048576,
    expectedCandidates: 10000,
  };
function fixture() {
  const buffers = new Map<string, Uint8Array>(),
    terms = new Map<string, DirectoryTerm>();
  for (const [word, ids, body, title] of [
    ["c", [1, 2, 7], [1, 0, 1], [0, 1, 0]],
    ["d", [2, 3, 7], [1, 1, 0], [0, 0, 1]],
    ["e", [3, 4, 7], [1, 1, 1], [0, 0, 0]],
  ] as const) {
    const raw = encodeScores(
        [...ids],
        [...body],
        [...title],
        [10, 10, 10],
        [2, 2, 2],
      ),
      key = "a".repeat(64) + `/plan-${terms.size}.bin`,
      ref: Ref = [terms.size, 0, raw.length];
    buffers.set(key, raw);
    terms.set(word, {
      id: terms.size + 1,
      df: ids.length,
      bodyOccurrences: 3,
      titleOccurrences: 1,
      frequencies: ref,
      positional: [0, 0, 0],
      tree: {
        first: ids[0],
        last: ids.at(-1)!,
        count: ids.length,
        height: 0,
        b: 1,
        t: 1,
        score: ref,
        positions: [0, 0, 0],
        locators: [0, 0, 0],
      },
    });
  }
  const corpus = {
      ...root,
      objects: [...buffers].map(([key, data]) => ({
        key,
        name: key.split("/")[1],
        size: data.length,
        sha256: "a".repeat(64),
      })),
    },
    reader = new Reader(corpus, {
      read: async (key, at, n) => buffers.get(key)!.slice(at, at + n),
    });
  return { terms, root: corpus, reader };
}
function plan(
  q: string,
  proved = new Set<string>(),
  excluded = new Set<string>(),
) {
  return planTermFilter(
    parse(q),
    fixture().terms,
    root,
    alternative,
    10000,
    proved,
    excluded,
    16384,
    false,
  );
}
it("prices complete Boolean filters without reading unknown OR sides or negative supersets", () => {
  expect(plan('"a b" AND (c OR d)')?.names.sort()).toEqual(["c", "d"]);
  expect(plan('"a b" AND (c OR unknown)')).toBeUndefined();
  expect(plan('"a b" AND NOT (c OR d)')).toBeUndefined();
  expect(plan('"a b" NOT (c OR d)')).toBeUndefined();
  expect(plan("c OR NOT d")).toBeUndefined();
  expect(plan("c OR (d AND missing)")?.names.sort()).toEqual(["c", "d"]);
  expect(plan('"a b" AND (c OR d) AND NOT e')?.names.sort()).toEqual([
    "c",
    "d",
  ]);
  expect(plan('"c d"', new Set(["c"]))?.names).toEqual(["d"]);
  expect(plan('"c d"', new Set(), new Set(["c", "d"]))).toBeUndefined();
  expect(
    planTermFilter(
      parse("c OR d"),
      fixture().terms,
      root,
      { ...alternative, kind: "complete-terms" },
      10000,
      new Set(),
      new Set(),
      16384,
      false,
    ),
  ).toBeUndefined();
  expect(
    planTermFilter(
      parse("c OR d"),
      fixture().terms,
      root,
      alternative,
      20,
      new Set(),
      new Set(),
      16384,
      false,
    ),
  ).toBeUndefined();
});
it("returns exact sorted field-aware supersets for nested Boolean expressions from real numeric packets", async () => {
  for (const [q, expected] of [
    [
      '"a b" AND (c OR d)',
      { all: [1, 2, 3, 7], body: [1, 2, 3, 7], title: [2, 7] },
    ],
    ["c AND (d OR e)", { all: [2, 7], body: [7], title: [] }],
    ["c OR c", { all: [1, 2, 7], body: [1, 7], title: [2] }],
  ] as const)
    for (const field of ["all", "body", "title"] as const) {
      const f = fixture(),
        selected = planTermFilter(
          parse(q),
          f.terms,
          f.root,
          alternative,
          10000,
          new Set(),
          new Set(),
          16384,
          false,
        )!;
      expect(selected).toBeDefined();
      const got = [
        ...(await readTermFilter(selected, f.terms, f.root, f.reader, field)),
      ];
      // A cheaper AND side may deliberately keep extra documents. Every true
      // query match must survive, in a unique sorted stream with its DF bound.
      expect(got).toEqual([...new Set(got)].sort((a, b) => a - b));
      expect(got).toEqual(expect.arrayContaining([...expected[field]]));
      expect(got.length).toBeLessThanOrEqual(selected.tree.df);
      expect(f.reader.stats.wordPositionIntegers).toBe(0);
      expect(f.reader.stats.booleanTermFilterWaves).toBe(1);
      expect(f.reader.stats.booleanTermFilterTerms).toBe(
        new Set(selected.names).size,
      );
    }
});
it("keeps a cheap OR filter instead of adding a costly AND list that makes all filtering lose", () => {
  const f = fixture();
  for (const [name, df, bytes] of [
    ["c", 300, 10000],
    ["d", 265, 10000],
    ["e", 40000, 500000],
  ] as const) {
    const t = f.terms.get(name)!;
    t.df = df;
    t.frequencies = [0, 0, bytes];
  }
  const selected = planTermFilter(
    parse('"a b" AND (c OR d) AND e'),
    f.terms,
    root,
    {
      ...alternative,
      frequencyBytes: 3 * 1048576,
      positionBytes: 7.5 * 1048576,
    },
    5706,
    new Set(),
    new Set(),
    10000,
    false,
  );
  expect(selected?.names.sort()).toEqual(["c", "d"]);
  expect(f.reader.stats.requests).toBe(0);
});
