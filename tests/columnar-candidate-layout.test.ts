import { it, expect } from "vitest";
import {
  ColumnarIndex,
  type ContinuationContext,
} from "../src/columnar/search.js";
import { Reader } from "../src/columnar/storage.js";
import type { Root, Branch } from "../src/columnar/format.js";
import type { PacketPlan } from "../src/columnar/packet-execution.js";
import { candidateLayout } from "../src/columnar/candidate-layout.js";
import { priceDocuments } from "../src/columnar/continuation.js";
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
it("compares score-ordered document verification with blocks without assuming all candidates verify", async () => {
  const { root, reader } = fixture(1000000);
  root.objects[0].size = 4 * 1048576;
  const tree: Branch = {
      first: 0,
      last: 999999,
      count: 1000000,
      height: 0,
      b: 10,
      t: 0,
      score: [0, 0, 400000],
      positions: [0, 3 * 1048576, 400000],
      locators: [0, 0, 0],
    },
    term = {
      id: 1,
      df: 1000000,
      tree,
      frequencies: [0, 0, 2 * 1048576] as [number, number, number],
      positional: tree.positions,
      bodyOccurrences: 2000000,
      titleOccurrences: 0,
    },
    plan: PacketPlan = {
      kind: "blocks",
      frequencyBytes: 2 * 1048576,
      positionBytes: 400000,
      expectedCandidates: 600,
      expectedDocumentBytes: 60000,
      gets: 0,
      dependentStages: 0,
    },
    candidates = Uint32Array.from({ length: 600 }, (_, i) => i * 1600),
    context = {
      root,
      reader,
      ast: { kind: "phrase" as const, terms: ["alpha", "alpha"] },
      terms: new Map([["alpha", term]]),
      options: { exactTotal: false },
      plan,
      packages: {
        averageBytes: 100,
        byteLength: () => 100,
        membership: membership(candidates.length, function* () {
          yield* candidates;
        }),
        load: async () => {
          throw Error("Planning must not open documents");
        },
      },
    },
    ranked = await priceDocuments(context, candidates, () => true),
    exhaustive = await priceDocuments(
      { ...context, options: { exactTotal: true } },
      candidates,
      () => true,
    );
  expect(ranked.kind).toBe("documents");
  expect(ranked.continuationCost?.rankingChecks).toBe(46);
  expect(ranked.continuationCost!.rankedWork).toBeLessThan(
    ranked.continuationCost!.blockWork,
  );
  expect(exhaustive.kind).toBe("blocks");
  expect(exhaustive.continuationCost?.rankingChecks).toBeUndefined();
  expect(reader.stats.requests).toBe(0);
});
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
it("compares a scattered candidate set with batched scoring rather than one fetch wave per band", async () => {
  const { root, index, reader } = fixture(1000000),
    tree: Branch = {
      first: 0,
      last: 999999,
      count: 128,
      height: 0,
      b: 1,
      t: 0,
      score: [0, 0, 100],
      positions: [0, 0, 0],
      locators: [0, 0, 0],
    },
    term = {
      id: 0,
      df: 128,
      tree,
      frequencies: [0, 0, 100] as [number, number, number],
      positional: [0, 0, 0] as [number, number, number],
      bodyOccurrences: 128,
      titleOccurrences: 0,
    },
    plan: PacketPlan = {
      kind: "documents",
      frequencyBytes: 100,
      positionBytes: 0,
      expectedCandidates: 120,
      expectedDocumentBytes: 12000,
      gets: 120,
      dependentStages: 2,
    };
  for (const count of [88, 120]) {
    const got = await index.choose({
      root,
      reader,
      ast: { kind: "term", term: "alpha" },
      terms: new Map([["alpha", term]]),
      options: {},
      plan,
      packages: {
        averageBytes: 100,
        byteLength: () => 100,
        load: async () => {
          throw Error("No package reads while planning");
        },
        membership: membership(count, function* () {
          for (let i = 0; i < count; i++) yield i * 8000;
        }),
      },
    });
    expect(got.kind).toBe("blocks");
    expect(got.continuationCost?.pageBytes).toBe(262144);
  }
  expect(reader.stats.requests).toBe(0);
});
it("prices delayed positional reads separately and omits proved or resident positions", async () => {
  const { root, index, reader } = fixture(1000000),
    tree: Branch = {
      first: 0,
      last: 999999,
      count: 10000,
      height: 0,
      b: 1,
      t: 0,
      score: [0, 0, 100],
      positions: [0, 524288, 100],
      locators: [0, 0, 0],
    },
    term = {
      id: 0,
      df: 10000,
      tree,
      frequencies: [0, 0, 100] as [number, number, number],
      positional: [0, 524288, 100] as [number, number, number],
      bodyOccurrences: 10000,
      titleOccurrences: 0,
    },
    terms = new Map([["alpha", term]]),
    ids = Uint32Array.from({ length: 120 }, (_, i) => i * 8000),
    ast = { kind: "phrase" as const, terms: ["alpha", "alpha"] },
    plan: PacketPlan = {
      kind: "blocks",
      frequencyBytes: 100,
      positionBytes: 100,
      expectedCandidates: ids.length,
      expectedDocumentBytes: 5000,
      gets: 0,
      dependentStages: 0,
    },
    context = {
      root,
      reader,
      ast,
      terms,
      options: {},
      plan,
      packages: {
        averageBytes: 100,
        byteLength: () => 100,
        load: async () => {
          throw Error("Planning does not load documents");
        },
        membership: membership(ids.length, function* () {
          yield* ids;
        }),
      },
    };
  const priced = await index.choose(context);
  // Cheap complete frequencies now make score-ordered verification preferable.
  // The positional alternative still has to include its delayed fetch waves.
  expect(priced.kind).toBe("documents");
  expect(priced.continuationCost?.positionWaves).toBeGreaterThan(0);
  expect(priced.continuationCost?.scoreDecodeMs).toBe(5);
  const proved = await candidateLayout(
    ast,
    terms,
    root,
    reader,
    ids,
    undefined,
    () => true,
  );
  expect(proved.positionBands).toBe(0);
  reader.memory.pages.set(
    `${generation}/${reader.namespace}/0/2`,
    new Uint8Array(262144),
    262144,
  );
  const resident = await candidateLayout(ast, terms, root, reader, ids);
  expect(resident.positionBands).toBe(0);
  expect(reader.stats.requests).toBe(0);
});
