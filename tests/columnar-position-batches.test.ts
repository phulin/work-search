import { it, expect } from "vitest";
import {
  PositionBatches,
  verificationColumns,
} from "../src/columnar/position-batches.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { PAGE, type Ref } from "../src/columnar/format.js";
import { ScoreBatch } from "../src/columnar/score-batch.js";
import {
  filteredPhraseWork,
  type ExactPhrasePlan,
} from "../src/columnar/exact-phrase.js";
import type { DirectoryTerm } from "../src/columnar/term-directory.js";

const generation = "b".repeat(64);
function fixture(pages: number) {
  const bytes = new Uint8Array(pages * PAGE);
  for (let i = 0; i < pages; i++) bytes.fill(i + 1, i * PAGE, (i + 1) * PAGE);
  const reads: number[][] = [],
    memory = new Memory();
  const reader = new Reader(
    {
      generation,
      objects: [{ name: "data", size: bytes.length, sha256: generation }],
    },
    {
      read: async (_key, offset, length) => {
        reads.push([offset, length]);
        return bytes.slice(offset, offset + length);
      },
    },
    memory,
  );
  return { reader, memory, reads };
}
it("coalesces adjacent pages across scored windows, preserves gaps and holds views through eviction", async () => {
  const { reader, memory, reads } = fixture(5),
    seen: number[] = [],
    released: number[] = [];
  // The active batch owns its buffers independently of this tiny LRU.
  Object.defineProperty(memory.pages, "limit", { value: PAGE + 512 });
  const batches = new PositionBatches(reader, 3 * PAGE);
  for (const [i, page] of [0, 1, 3].entries()) {
    const ref: Ref = [0, page * PAGE + 10, 40];
    await batches.add({
      count: 1,
      bytes: 20,
      refs: () => [ref, ref],
      run: (_from, _to, data) => {
        expect([...data.get(reader.key(ref))!]).toEqual(
          Array(40).fill(page + 1),
        );
        seen.push(i);
      },
      release: () => {
        released.push(i);
      },
    });
  }
  expect(seen).toEqual([]);
  await batches.flush();
  expect(seen).toEqual([0, 1, 2]);
  expect(released).toEqual(seen);
  expect(reads).toEqual([
    [0, 2 * PAGE],
    [3 * PAGE, PAGE],
  ]);
  expect(reader.stats.positionIOWaves).toBe(1);
  expect(reader.stats.wordPositionBlocks).toBe(3);
  expect(reader.stats.maxPositionFootprintBytes).toBe(3 * PAGE);
});
it("splits oversized candidate groups by physical bytes without dropping candidates", async () => {
  const { reader } = fixture(9),
    seen: number[] = [];
  const batches = new PositionBatches(reader, 2 * PAGE);
  await batches.add({
    count: 9,
    bytes: 9 * 20,
    refs: (from, to) =>
      Array.from({ length: to - from }, (_, i): Ref => [
        0,
        (from + i) * PAGE + 4,
        20,
      ]),
    run: (from, to, data) => {
      for (let i = from; i < to; i++) {
        expect(data.get(reader.key([0, i * PAGE + 4, 20]))![0]).toBe(i + 1);
        seen.push(i);
      }
    },
    release: () => {},
  });
  await batches.flush();
  expect(seen).toEqual(Array.from({ length: 9 }, (_, i) => i));
  expect(reader.stats.positionIOWaves).toBeGreaterThan(1);
  expect(reader.stats.maxPositionFootprintBytes).toBeLessThanOrEqual(2 * PAGE);
});
it("copies candidate-only numeric evidence before scoring workspaces are reused", () => {
  const batch = new ScoreBatch(16384, { idf: 1, avgBody: 10, avgTitle: 1 });
  batch.reset(16384, 16384);
  batch.count = 3;
  batch.docs.set([16385, 16387, 16390]);
  batch.body.set([1, 2, 3]);
  batch.blockIndex.set([0, 1, 2]);
  batch.blockRow.set([5, 6, 7]);
  batch.handle[1] = 1;
  batch.handle[3] = 2;
  batch.handle[6] = 3;
  const snapshot = verificationColumns(
    [batch.columns()],
    Uint32Array.of(16385, 16386, 16390),
    16384,
  )[0];
  batch.reset(32768, 16384);
  batch.docs.fill(0);
  batch.body.fill(0);
  batch.blockIndex.fill(0);
  batch.blockRow.fill(0);
  expect([...snapshot.docs]).toEqual([16385, 16390]);
  expect([...snapshot.body]).toEqual([1, 3]);
  expect([...snapshot.blockIndex]).toEqual([0, 2]);
  expect([...snapshot.blockRow]).toEqual([5, 7]);
  expect(Object.values(snapshot).reduce((n, a) => n + a.byteLength, 0)).toBe(
    34,
  );
});
it("prices sparse phrase verification by physical pages and stages rather than DF-scaled bytes", async () => {
  const { reader, memory } = fixture(4);
  const terms = new Map(
    ["a", "b"].map((word, id) => [
      word,
      {
        id,
        df: 100000,
        bodyOccurrences: 100000,
        titleOccurrences: 0,
        positional: [0, id * 2 * PAGE, 64],
        tree: {
          height: 0,
          first: 1,
          last: 16385,
          count: 2,
          b: 1,
          t: 0,
          positions: [0, id * 2 * PAGE, 64],
          score: [0, 0, 64],
          locators: [0, 0, 0],
        },
      } as DirectoryTerm,
    ]),
  );
  const plan = {
    words: ["a", "b"],
    bytes: 65536,
    pair: {
      bodyOccurrences: 100,
      titleOccurrences: 0,
      directory: {
        generation,
        a: 0,
        b: 1,
        ranges: [{ object: 0, offset: 0, length: 65536 }],
      },
    },
  } as ExactPhrasePlan;
  const work = await filteredPhraseWork(
    plan,
    Uint32Array.of(1, 16385),
    terms,
    "all",
    reader,
  );
  expect(work.bytes).toBe(128);
  expect(work.physicalBytes).toBe(2 * PAGE);
  expect(work.dependentStages).toBeGreaterThan(0);
  expect(work.preferFiltered).toBe(false);
  for (const page of [0, 2])
    memory.pages.set(
      `${generation}/default/0/${page}`,
      new Uint8Array(PAGE),
      PAGE,
    );
  const warm = await filteredPhraseWork(
    plan,
    Uint32Array.of(1, 16385),
    terms,
    "all",
    reader,
  );
  expect(warm.missingBytes).toBe(0);
  expect(warm.preferFiltered).toBe(true);
});
