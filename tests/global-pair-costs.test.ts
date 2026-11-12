import { it, expect } from "vitest";
import { PairCostTable, encodePairCosts } from "../src/global/pair-costs.js";
import {
  PairFilter,
  encodePairEntry,
  type PairRoot,
} from "../src/global/pairs.js";
import { encodeDictionary } from "../src/global/format.js";
import type { PageReader } from "../src/global/storage.js";
import { parse } from "../src/query/parser.js";
const base = "a".repeat(64),
  generation = "b".repeat(64);
it("bounds corpus pair DF despite collisions and pins/checksums the complete synopsis", () => {
  const entries = Array.from(
    { length: 80000 },
    (_, i) => ["term" + i + "\0other", (i % 100000) + 1] as [string, number],
  );
  const bytes = encodePairCosts(entries, base, generation),
    costs = new PairCostTable(bytes, base, generation);
  expect(bytes.length).toBe(245912);
  for (const [k, n] of entries)
    if (costs.upper(k) !== undefined)
      expect(costs.upper(k)).toBeGreaterThanOrEqual(n);
  expect(() => new PairCostTable(bytes, "c".repeat(64), generation)).toThrow(
    "generation",
  );
  const corrupt = bytes.slice();
  corrupt[200] ^= 1;
  expect(() => new PairCostTable(corrupt, base, generation)).toThrow(
    "checksum",
  );
  expect(encodePairCosts(entries, base, generation)).toEqual(bytes);
});
it("avoids non-pruning Boolean discovery, selective unigram discovery and dense pairs; chooses one cheap pair", async () => {
  const entries = [
    ["a\0b", encodePairEntry({ df: 4, inlineDocs: [0, 1, 2, 3], blocks: [] })],
    ["b\0c", encodePairEntry({ df: 2, inlineDocs: [1, 3], blocks: [] })],
  ] as [string, Uint8Array][];
  const bytes = encodeDictionary(entries),
    calls: string[] = [];
  const reader = {
    root: { generation },
    async readMany(refs: unknown[], stage: string) {
      calls.push(stage);
      return refs.map(() => bytes);
    },
  } as unknown as PageReader;
  const root = {
    root: {
      generation,
      dictionary: [
        {
          first: "a\0b",
          last: "b\0c",
          address: [0, 0, bytes.length, 0, bytes.length],
        },
      ],
    },
    entryEncoding: "binary-v2",
  } as PairRoot;
  const filter = new PairFilter(root, reader, 32768, true),
    upper = (k: string) => (k === "b\0c" ? 2 : 4);
  expect(
    await filter.queryCandidates(parse('"a b c"'), { upper, df: () => 10000 }),
  ).toEqual(new Set([1, 3]));
  expect(calls).toEqual(["pair-dictionary"]);
  calls.length = 0;
  for (const q of ['"a b c" OR other', 'other NOT "a b c"'])
    expect(
      await filter.queryCandidates(parse(q), { upper, df: () => 10000 }),
    ).toBeUndefined();
  expect(
    await filter.queryCandidates(parse('"a b c"'), { upper, df: () => 100 }),
  ).toBeUndefined();
  expect(
    await filter.queryCandidates(parse('"a b c"'), {
      upper: () => 9000,
      df: () => 10000,
    }),
  ).toBeUndefined();
  expect(calls).toEqual([]);
});
