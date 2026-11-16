import { expect, it } from "vitest";
import {
  advanceCursor,
  arrayCursor,
  intersectCursors,
  unionCursors,
  type NumericCursor,
} from "../src/columnar/numeric-cursor.js";
const cursor = (values: number[]): NumericCursor => {
  let i = 0;
  return { next: () => values[i++] ?? Infinity };
};
const collect = (c: NumericCursor) => {
  const out = [];
  for (let doc = c.next(); doc !== Infinity; doc = c.next()) out.push(doc);
  expect(c.next()).toBe(Infinity);
  return out;
};
it("intersects sorted memberships exactly across gaps, empty inputs and unequal tails", () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed >>> 0;
  };
  for (let trial = 0; trial < 30; trial++) {
    const lists = Array.from({ length: 2 + (trial % 4) }, () =>
      Array.from({ length: 1000 }, (_, i) => i).filter(
        () => random() % 5 === 0,
      ),
    );
    const sets = lists.map((a) => new Set(a));
    expect(collect(intersectCursors(lists.map(cursor)))).toEqual(
      lists[0].filter((doc) => sets.every((s) => s.has(doc))),
    );
  }
  expect(collect(intersectCursors([]))).toEqual([]);
  expect(collect(intersectCursors([cursor([0, 128, 999])]))).toEqual([
    0, 128, 999,
  ]);
});
it("unions fields in document order without duplicate candidates", () => {
  expect(
    collect(unionCursors(cursor([0, 2, 3, 128, 999]), cursor([0, 1, 3, 1000]))),
  ).toEqual([0, 1, 2, 3, 128, 999, 1000]);
  expect(collect(unionCursors(cursor([]), cursor([0])))).toEqual([0]);
});
it("seeks through nested Boolean streams without losing current heads or revisiting consumed documents", () => {
  const seekable = (values: number[]): NumericCursor => {
    let row = 0;
    return {
      next: () => values[row++] ?? Infinity,
      advance: (target) => {
        while (row < values.length && values[row] < target) row++;
        return values[row++] ?? Infinity;
      },
    };
  };
  for (const optimized of [false, true]) {
    const make = optimized ? seekable : cursor,
      c = intersectCursors([
        unionCursors(make([0, 10, 20, 40, 90]), make([5, 20, 50, 100])),
        make([0, 5, 20, 30, 40, 50, 100, 110]),
      ]);
    expect(c.next()).toBe(0);
    expect(advanceCursor(c, 19)).toBe(20);
    expect(advanceCursor(c, 20)).toBe(40);
    expect(c.next()).toBe(50);
    expect(advanceCursor(c, 80)).toBe(100);
    expect(advanceCursor(c, Infinity)).toBe(Infinity);
    expect(c.next()).toBe(Infinity);
  }
});
it("matches exhaustive sets for mixed next and seek operations across nested intersections and unions", () => {
  let seed = 91;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let trial = 0; trial < 100; trial++) {
    const lists = Array.from({ length: 4 }, () =>
        Uint32Array.from(
          Array.from({ length: 2000 }, (_, i) => i).filter(
            () => random() % 4 === 0,
          ),
        ),
      ),
      union = (a: Uint32Array, b: Uint32Array) => [...new Set([...a, ...b])],
      right = new Set(union(lists[2], lists[3])),
      expected = union(lists[0], lists[1])
        .filter((d) => right.has(d))
        .sort((a, b) => a - b),
      c = intersectCursors([
        unionCursors(arrayCursor(lists[0]), arrayCursor(lists[1])),
        unionCursors(arrayCursor(lists[2]), arrayCursor(lists[3])),
      ]);
    let at = 0,
      last = -1;
    for (let i = 0; i < 100; i++) {
      const seek = random() % 3 !== 0,
        target = last + (random() % 70);
      if (seek) while (at < expected.length && expected[at] < target) at++;
      const next = expected[at++] ?? Infinity;
      expect(seek ? advanceCursor(c, target) : c.next()).toBe(next);
      last = next;
    }
  }
});
