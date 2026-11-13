import { expect, it } from "vitest";
import {
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
