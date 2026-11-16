import { expect, it } from "vitest";
import { unionReadRanges } from "../bench/columnar/read-ranges.js";

it("deduplicates transferred coverage without making unread holes available", () => {
  const input = [
      { key: "a", offset: 100, length: 7 },
      { key: "a", offset: 20, length: 10 },
      { key: "a", offset: 5, length: 20 },
      { key: "a", offset: 0, length: 5 },
      { key: "b", offset: 10, length: 20 },
      { key: "a", offset: 5, length: 20 },
    ],
    result = unionReadRanges(input);
  for (const key of ["a", "b"])
    for (let byte = 0; byte < 120; byte++)
      expect(
        result.some(
          (r) =>
            r.key === key && byte >= r.offset && byte < r.offset + r.length,
        ),
      ).toBe(
        input.some(
          (r) =>
            r.key === key && byte >= r.offset && byte < r.offset + r.length,
        ),
      );
  expect(result.reduce((n, r) => n + r.length, 0)).toBe(57);
  expect(() =>
    unionReadRanges([{ key: "a", offset: -1, length: 1 }]),
  ).toThrow();
});
