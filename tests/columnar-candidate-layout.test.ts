import { it, expect } from "vitest";
import {
  ColumnarIndex,
  type ContinuationContext,
} from "../src/columnar/search.js";
import { Reader } from "../src/columnar/storage.js";
import type { Root, Branch } from "../src/columnar/format.js";
import type { PacketPlan } from "../src/columnar/packet-execution.js";
const generation = "a".repeat(64);
class Planner extends ColumnarIndex {
  choose(c: ContinuationContext) {
    return this.chooseContinuation(c);
  }
}
function fixture(count: number) {
  const root = {
    format: "CWS1",
    generation,
    analysis: undefined,
    count,
    avgBody: 10,
    avgTitle: 1,
    corpusHash: "b".repeat(64),
    documents: [],
    dictionaries: [],
    hot: {},
    objects: [{ name: "plan-0.bin", size: 1048576, sha256: generation }],
    documentPackages: {
      generation,
      count,
      averageBytes: 100,
      bytes: count * 100,
    },
  } as Root;
  return {
    root,
    index: new Planner(root),
    reader: new Reader(root, {
      read: async () => {
        throw Error("No remote discovery for inline leaf plans");
      },
    }),
  };
}
function membership(count: number, values: () => Generator<number>) {
  return {
    count,
    values,
    has: () => true,
    cursor: () => ({ next: () => Infinity }),
    covered: () => false,
    evidence: () => undefined,
  };
}
it("prices physical pages rather than tiny logical score and position spans", async () => {
  const { root, index, reader } = fixture(1000),
    tree: Branch = {
      first: 0,
      last: 999,
      count: 2,
      height: 0,
      b: 10,
      t: 0,
      score: [0, 0, 32],
      positions: [0, 524288, 400],
      locators: [0, 0, 0],
    },
    term = {
      id: 0,
      df: 2,
      tree,
      frequencies: [0, 0, 100] as [number, number, number],
      positional: [0, 524288, 400] as [number, number, number],
      bodyOccurrences: 4,
      titleOccurrences: 0,
    },
    plan: PacketPlan = {
      kind: "blocks",
      frequencyBytes: 100 * 1048576,
      positionBytes: 0,
      expectedCandidates: 2,
      expectedDocumentBytes: 200,
      gets: 0,
      dependentStages: 0,
    },
    packages = {
      averageBytes: 100,
      byteLength: () => 100,
      load: async () => {
        throw Error("No packages during planning");
      },
      membership: membership(2, function* () {
        yield 0;
        yield 999;
      }),
    },
    got = await index.choose({
      root,
      reader,
      ast: { kind: "phrase", terms: ["alpha", "alpha"] },
      terms: new Map([["alpha", term]]),
      options: {},
      packages,
      plan,
    });
  expect(got.kind).toBe("documents");
  expect(got.continuationCost!.pageBytes).toBe(2 * 262144);
  expect(got.continuationCost!.packageBytes).toBe(200);
  expect(reader.stats.requests).toBe(0);
});
it("rejects an expensive streaming prefix without walking a whole-corpus plan or candidate set", async () => {
  const { root, index, reader } = fixture(1000000);
  let visited = 0;
  const packages = {
      averageBytes: 1024,
      byteLength: () => 1024,
      load: async () => {
        throw Error("No package loads");
      },
      membership: membership(root.count, function* () {
        for (let i = 0; i < root.count; i++) {
          visited++;
          yield i;
        }
      }),
    },
    plan: PacketPlan = {
      kind: "blocks",
      frequencyBytes: 1024,
      positionBytes: 0,
      expectedCandidates: root.count,
      expectedDocumentBytes: root.count * 1024,
      gets: 0,
      dependentStages: 0,
    };
  expect(
    (
      await index.choose({
        root,
        reader,
        ast: { kind: "term", term: "alpha" },
        terms: new Map(),
        options: {},
        packages,
        plan,
      })
    ).kind,
  ).toBe("blocks");
  expect(visited).toBeGreaterThan(0);
  expect(visited).toBeLessThan(1000);
});
it("avoids detailed remote plans when package waves already beat the score-window estimate", async () => {
  const { root, index, reader } = fixture(1000000),
    plan: PacketPlan = {
      kind: "blocks",
      frequencyBytes: 104857600,
      positionBytes: 0,
      expectedCandidates: 2,
      expectedDocumentBytes: 200,
      gets: 0,
      dependentStages: 0,
    };
  const got = await index.choose({
    root,
    reader,
    ast: { kind: "term", term: "alpha" },
    terms: new Map(),
    options: {},
    plan,
    packages: {
      averageBytes: 100,
      byteLength: () => 100,
      load: async () => {
        throw Error("No package reads while planning");
      },
      membership: membership(2, function* () {
        yield 0;
        yield 999999;
      }),
    },
  });
  expect(got.kind).toBe("documents");
  expect(got.continuationCost?.waveEstimateOnly).toBe(true);
  expect(got.continuationCost?.metadataBytes).toBe(0);
  expect(reader.stats.requests).toBe(0);
});
