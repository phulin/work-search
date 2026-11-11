import { it, expect } from "vitest";
import { parse } from "../src/query/parser.js";
import { positionalMatcher as current } from "../src/query/evaluate.js";
import { positionalMatcher as baseline } from "../bench/baseline-v3/evaluate.js";
import {
  encodePostings,
  decodePostings,
  type Posting,
} from "../src/format/codec.js";
it("matches the frozen span evaluator for randomized nested expressions and every field", () => {
  let seed = 71;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const words = ["a", "b", "c", "d", "e", "f"];
  const postings = new Map<string, Posting[]>();
  for (let doc = 0; doc < 120; doc++) {
    const body = Array.from(
        { length: rand(14) },
        () => words[rand(words.length)],
      ),
      title = Array.from({ length: rand(7) }, () => words[rand(words.length)]);
    for (const term of words) {
      const bp = body.flatMap((x, i) => (x === term ? [i] : [])),
        tp = title.flatMap((x, i) => (x === term ? [i] : []));
      if (bp.length + tp.length) {
        let list = postings.get(term);
        if (!list) postings.set(term, (list = []));
        list.push({
          doc,
          body: bp.length,
          title: tp.length,
          bodyPositions: bp,
          titlePositions: tp,
        });
      }
    }
  }
  const lists = new Map(
    [...postings].map(([term, list]) => [
      term,
      decodePostings(encodePostings(list), list.length, true),
    ]),
  );
  function query(depth: number): string {
    if (!depth)
      return rand(3) ? words[rand(6)] : `"${words[rand(6)]} ${words[rand(6)]}"`;
    const op = ["AND", "OR", "AND NOT", "/1", "/3", "+2"][rand(6)];
    return `(${query(depth - 1)} ${op} ${query(depth - 1)})`;
  }
  const queries = Array.from({ length: 180 }, () => query(2));
  queries.push(
    '((a /3 b) OR c) /2 (d OR "e f")',
    "(a AND (NOT b)) /2 c",
    "((a AND b) OR c) /2 d",
  );
  for (const q of queries)
    for (const field of ["all", "body", "title"] as const) {
      const old = baseline(parse(q), lists, field),
        next = current(parse(q), lists, field);
      for (let doc = 0; doc < 120; doc++)
        expect(next(doc), q + " " + field + " " + doc).toBe(old(doc));
    }
});
it("handles dense existence checks without building Cartesian products or truncating matches", () => {
  const list = (term: number) =>
    decodePostings(
      encodePostings([
        {
          doc: 0,
          body: 20000,
          title: 0,
          bodyPositions: Array.from({ length: 20000 }, (_, i) => i * 2 + term),
          titlePositions: [],
        },
      ]),
      1,
      true,
    );
  const lists = new Map([
    ["a", list(0)],
    ["b", list(1)],
  ]);
  for (const q of ["a /1 b", "a +1 b", '"a b"', "a /s a"])
    expect(current(parse(q), lists, "body")(0), q).toBe(true);
  expect(current(parse('"a a"'), lists, "body")(0)).toBe(false);
});
it("revisits earlier document IDs safely and isolates query-local scratch", () => {
  const list = decodePostings(
    encodePostings([
      { doc: 0, body: 1, title: 1, bodyPositions: [0], titlePositions: [5] },
      { doc: 10000, body: 1, title: 0, bodyPositions: [8], titlePositions: [] },
    ]),
    2,
    true,
  );
  const run = current(parse("a /1 a"), new Map([["a", list]]), "all");
  for (const id of [10000, 0, 9999, 0]) expect(run(id)).toBe(false);
});
it("preserves later nested matches, overlapping spans and nonmonotone interval ends", () => {
  const make = (positions: number[]) =>
    decodePostings(
      encodePostings([
        {
          doc: 0,
          body: positions.length,
          title: 0,
          bodyPositions: positions,
          titlePositions: [],
        },
      ]),
      1,
      true,
    );
  const lists = new Map([
    ["a", make([0])],
    ["b", make([100])],
    ["c", make([50])],
    ["d", make([51])],
  ]);
  for (const q of ["((a /100 b) OR c) +1 d", "((a /100 b) OR c) /1 d"])
    expect(current(parse(q), lists, "body")(0)).toBe(true);
  expect(current(parse("(a /100 b) /10 c"), lists, "body")(0)).toBe(false);
  const later = new Map([
    ["a", make([0, 50])],
    ["b", make([1, 51])],
    ["c", make([53])],
  ]);
  expect(current(parse("(a /1 b) /2 c"), later, "body")(0)).toBe(true);
});
it("caps retained compound-span scratch across the entire query", () => {
  const make = (positions: number[]) =>
    decodePostings(
      encodePostings([
        {
          doc: 0,
          body: positions.length,
          title: 0,
          bodyPositions: positions,
          titlePositions: [],
        },
      ]),
      1,
      true,
    );
  const lists = new Map([
    ["a", make(Array.from({ length: 1000 }, (_, i) => i))],
    ["b", make([1000])],
  ]);
  const q = "(" + Array(45).fill("a").join(" OR ") + ") /1 b";
  expect(() => current(parse(q), lists, "body")(0)).toThrow("scratch limit");
});
