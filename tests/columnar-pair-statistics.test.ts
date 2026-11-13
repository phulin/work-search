import { it, expect } from "vitest";
import {
  documentGroupPairStatistics,
  mergePairStatistics,
  PairStatistics,
} from "../src/columnar/construction/pair-statistics.js";
import { encodeDocumentPackage } from "../src/columnar/document-package.js";
import { concat } from "../src/columnar/format.js";
it("retains occurrence counts above 32 bits during global merges", () => {
  const make = (first: number) => {
    const bytes = new Uint8Array(32),
      v = new DataView(bytes.buffer);
    v.setUint32(0, 0x31535043, true);
    v.setUint32(4, 1, true);
    v.setUint32(8, first, true);
    v.setUint32(12, first + 2, true);
    v.setUint32(16, 0, true);
    v.setUint32(20, 2, true);
    v.setFloat64(24, 2 ** 32 + 7, true);
    return new PairStatistics(bytes);
  };
  const merged = new PairStatistics(mergePairStatistics([make(0), make(2)]));
  expect(merged.df(0)).toBe(4);
  expect(merged.occurrences(0)).toBe(2 ** 33 + 14);
  expect(() => mergePairStatistics([make(0), make(0)])).toThrow();
});
it("counts adjacent pairs without crossing fields and merges to exhaustive corpus totals", async () => {
  const ids = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]),
    docs = [
      ["a a b c a", "a b"],
      ["b c a a", "a a"],
      ["a d b", "c a"],
      ["a b a b", "a b"],
      ["c b", ""],
    ],
    selected = [2, 0, 1],
    expected = new Map<number, { df: number; occurrences: number }>(),
    runs: PairStatistics[] = [];
  docs.forEach((fields) => {
    const seen = new Set<number>();
    for (const text of fields) {
      const ts = text
        .split(" ")
        .filter(Boolean)
        .map((t) => selected.indexOf(ids.get(t)!));
      for (let p = 0; p + 1 < ts.length; p++)
        if (ts[p] >= 0 && ts[p + 1] >= 0) {
          const key = ts[p] * 3 + ts[p + 1],
            s = expected.get(key) ?? { df: 0, occurrences: 0 };
          s.occurrences++;
          if (!seen.has(key)) s.df++;
          seen.add(key);
          expected.set(key, s);
        }
    }
  });
  for (let first = 0; first < docs.length; first += 2) {
    const packets = [];
    for (let doc = first; doc < Math.min(first + 2, docs.length); doc++)
      packets.push(
        await encodeDocumentPackage(
          { doc, id: String(doc), body: docs[doc][0], title: docs[doc][1] },
          ids,
        ),
      );
    const offsets = [0];
    for (const p of packets) offsets.push(offsets.at(-1)! + p.length);
    runs.push(
      new PairStatistics(
        documentGroupPairStatistics(
          concat(packets),
          Uint32Array.from(offsets),
          first,
          selected,
        ),
      ),
    );
  }
  const merged = new PairStatistics(mergePairStatistics(runs));
  expect(merged.count).toBe(expected.size);
  for (let i = 0; i < merged.count; i++)
    expect({ df: merged.df(i), occurrences: merged.occurrences(i) }).toEqual(
      expected.get(merged.key(i)),
    );
  expect(() => new PairStatistics(merged.bytes.subarray(1))).toThrow();
  expect(() => mergePairStatistics([...runs, ...runs])).toThrow();
});
