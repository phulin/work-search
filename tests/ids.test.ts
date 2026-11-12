import { it, expect } from "vitest";
import { encodeIds, IdTable } from "../src/format/ids.js";
it("restarts compact Unicode IDs and handles empty, long and arbitrary identifiers", () => {
  const ids = Array.from({ length: 99 }, (_, i) =>
    i === 33 ? "long".repeat(20000) : `court:判例:😀:${i}`,
  );
  ids[0] = "";
  ids[32] = "x";
  const bytes = encodeIds(ids.length, (i) => ids[i]),
    table = new IdTable(bytes, ids.length);
  for (let i = 0; i < ids.length; i++) expect(table.get(i)).toBe(ids[i]);
  expect(() => table.get(-1)).toThrow();
  expect(() => table.get(ids.length)).toThrow();
  expect(
    () => new IdTable(bytes.subarray(0, bytes.length - 1), ids.length),
  ).toThrow();
  expect(
    new IdTable(
      encodeIds(0, () => ""),
      0,
    ).count,
  ).toBe(0);
});
