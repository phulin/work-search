import { it, expect } from "vitest";
import { assembleRange } from "../bench/range-mirror.js";
it("assembles existing adjacent ranges when a previously assembled larger interval has no backing file", async () => {
  const intervals = [
    { offset: 0, length: 4 },
    { offset: 0, length: 2 },
    { offset: 2, length: 2 },
  ];
  const bytes = await assembleRange(0, 4, intervals, async (r) => {
    if (r.length === 4) throw Error("Missing file");
    return Uint8Array.of(r.offset + 1, r.offset + 2);
  });
  expect([...bytes!]).toEqual([1, 2, 3, 4]);
  expect(intervals).toHaveLength(2);
  expect(
    await assembleRange(0, 5, intervals, async (r) => new Uint8Array(r.length)),
  ).toBeNull();
});
