import { it, expect } from "vitest";
import { scoreLookahead } from "../src/columnar/score-lookahead.js";
import { Reader } from "../src/columnar/storage.js";
import type { Ref } from "../src/columnar/format.js";
const reader = new Reader(
    { generation: "a".repeat(64), objects: [] },
    {
      read: async () => {
        throw Error("No reads during planning");
      },
    },
  ),
  footprint = (refs: Ref[]) => reader.packetFootprint(refs);
it("groups consecutive filtered windows inside the physical page budget", () => {
  const groups: Ref[][] = [
    [[0, 0, 100]],
    [[0, 262144, 100]],
    [[0, 524288, 100]],
    [[0, 786432, 100]],
  ];
  const a = scoreLookahead(groups, 524288, footprint);
  expect(a.windows).toBe(2);
  expect(a.bytes).toBe(524288);
  expect(footprint(a.refs)).toBeLessThanOrEqual(524288);
  const b = scoreLookahead(groups.slice(a.windows), 524288, footprint);
  expect(b.windows).toBe(2);
  expect([...a.refs, ...b.refs]).toEqual(groups.flat());
});
it("bounds oversized windows and progresses over empty groups without dropping execution requirements", () => {
  const groups: Ref[][] = [Array.from({ length: 16 }, (_, i) => [i, 0, 100])];
  const a = scoreLookahead(groups, 1048576, footprint);
  expect(a.windows).toBe(1);
  expect(a.partial).toBe(true);
  expect(a.bytes).toBeLessThanOrEqual(1048576);
  expect(a.refs.length).toBeLessThan(groups[0].length);
  expect(scoreLookahead([[], []], 1048576, footprint)).toEqual({
    refs: [],
    windows: 2,
    bytes: 0,
    partial: false,
  });
});
