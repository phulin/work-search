import { it, expect } from "vitest";
import { packageBatches } from "../src/columnar/package-batches.js";
it("streams every candidate in order using actual sizes and bounded concurrency", () => {
  let produced = 0;
  function* input() {
    for (let i = 0; i < 2000; i++) {
      produced++;
      yield { doc: i, bytes: (i % 7) + 1 };
    }
  }
  const batches = packageBatches(input(), (d) => d.bytes, 15, 3);
  const first = batches.next().value!;
  expect(produced).toBeLessThan(10);
  const all = [first, ...batches];
  expect(all.flatMap((g) => g.items).map((d) => d.doc)).toEqual(
    Array.from({ length: 2000 }, (_, i) => i),
  );
  for (const g of all) {
    expect(g.items.length).toBeLessThanOrEqual(3);
    expect(g.bytes).toBeLessThanOrEqual(15);
    expect(g.bytes).toBe(g.items.reduce((n, d) => n + d.bytes, 0));
  }
});
it("runs unavoidable oversized single packages alone without dropping neighbors", () => {
  const groups = [...packageBatches([2, 25, 3, 4], (n) => n, 10, 6)];
  expect(groups.map((g) => g.items)).toEqual([[2], [25], [3, 4]]);
  expect(groups.map((g) => g.oversized)).toEqual([false, true, false]);
  expect([...packageBatches([], () => 1)]).toEqual([]);
});
