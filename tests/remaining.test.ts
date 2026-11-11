import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { selectStreams } from "../src/builder/selection.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { rangeGroups } from "../src/query/ranges.js";
import { intersect, lowerBound } from "../src/query/sets.js";
import { candidatePlan } from "../src/query/planning.js";
import { parse } from "../src/query/parser.js";
import { handler } from "../src/worker/handler.js";
it("joint packages respect budgets, phrases, weights, missing terms and determinism", () => {
  const items = [
    { term: "rare", length: 10, positionLength: 5 },
    { term: "common", length: 10, positionLength: 5 },
    { term: "other", length: 20, positionLength: 20 },
  ];
  const workload = ["rare /s common", "rare /s common", "other"];
  const a = selectStreams(items, 30, workload),
    b = selectStreams(items, 30, workload);
  expect(a).toEqual(b);
  expect([...a.frequencies].sort()).toEqual(["common", "rare"]);
  expect([...a.positions].sort()).toEqual(["common", "rare"]);
  expect(selectStreams(items, 0, workload).frequencies.size).toBe(0);
  expect(() =>
    selectStreams(items, 30, ["missing", "rare AND NOT common"]),
  ).not.toThrow();
});
it("galloping intersections agree with sets over deterministic skewed inputs", () => {
  for (let size = 0; size < 200; size++) {
    const a = Uint32Array.from({ length: size }, (_, i) => i * 29),
      b = Uint32Array.from({ length: size * 30 }, (_, i) => i * 3);
    expect([...intersect(a, b)]).toEqual([...a].filter((x) => b.includes(x)));
    for (const target of [0, 1, 100, 100000])
      expect(lowerBound(b, target)).toBe(
        [...b].filter((x) => x < target).length,
      );
  }
});
it("range partitions minimize requests-plus-bytes under the range cap", () => {
  const starts = [0, 10, 100, 110, 1000],
    ids = [0, 1, 2, 3, 4],
    extent = (i: number) => ({ start: starts[i], end: starts[i] + 5 });
  for (const overhead of [0, 20, 100, 1000])
    for (const cap of [1, 2, 4]) {
      const groups = rangeGroups(ids, extent, overhead, cap),
        cost = (groups: number[][]) =>
          groups.reduce(
            (s, g) =>
              s + extent(g[g.length - 1]).end - extent(g[0]).start + overhead,
            0,
          );
      let best = Infinity;
      for (let mask = 0; mask < 16; mask++) {
        const p: number[][] = [[]];
        for (let i = 0; i < ids.length; i++) {
          if (i && mask & (1 << (i - 1))) p.push([]);
          p[p.length - 1].push(i);
        }
        if (p.length <= cap) best = Math.min(best, cost(p));
      }
      expect(cost(groups)).toBe(best);
    }
});
it("candidate plans cover disjunctive rare anchors and exclude negative-only anchors", () => {
  const plan = candidatePlan(parse("(rare OR uncommon) AND common"), (t) =>
    t === "common" ? 100000 : 10,
  )!;
  expect([...plan.terms].sort()).toEqual(["rare", "uncommon"]);
  expect(candidatePlan(parse("NOT rare"), () => 1)).toBeUndefined();
});
it("bounded LRU rejects oversized values, evicts least recently used and respects headroom", () => {
  const runtime = new SearchRuntime(1000);
  runtime.set("a", 1, 200);
  runtime.set("b", 2, 200);
  expect(runtime.get("a")).toBe(1);
  runtime.set("c", 3, 200);
  expect(runtime.get("b")).toBeUndefined();
  expect(runtime.bytes).toBeLessThanOrEqual(1000);
  runtime.set("huge", 9, 2000);
  expect(runtime.get("huge")).toBeUndefined();
  runtime.setLimit(0);
  expect(runtime.bytes).toBe(0);
  runtime.set("small", 1, 1);
  expect(runtime.bytes).toBe(0);
});
it("adaptive planning, deferred positions, caching and block-max pruning preserve exact results", async () => {
  const root = await mkdtemp(join(tmpdir(), "remaining-"));
  try {
    const docs = Array.from({ length: 3101 }, (_, i) => ({
      id: `doc-${i}`,
      body:
        "common " +
        "word ".repeat(1 + (i % 7)) +
        (i % 257 === 0 ? "rare " : "") +
        (i % 263 === 0 ? "uncommon " : "") +
        (i % 11 === 0 ? "excluded " : "") +
        "noise ".repeat(i % 19),
      title: i % 5 === 0 ? "word common" : "other",
    }));
    const input = join(root, "docs");
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const full = await build({ input, out: join(root, "full") });
    const remote = await build({
      input,
      out: join(root, "remote"),
      budget: full.bundleBytes - full.embeddedBytes,
    });
    const mixedOptions = {
      input,
      out: join(root, "mixed"),
      strategy: "mixed" as const,
      budget: Math.min(
        full.bundleBytes,
        full.bundleBytes - full.embeddedBytes + 15000,
      ),
      workload: ["common /s word", "rare common", "word OR common"],
    };
    const mixed = await build(mixedOptions);
    const deterministic = await build({
      ...mixedOptions,
      out: join(root, "mixed-repeat"),
      chunkDocs: 128,
    });
    expect(mixed.bundleSha256).toBe(deterministic.bundleSha256);
    expect(mixed.bundleBytes).toBeLessThanOrEqual(mixed.budget);
    const queries = [
      "",
      "missing",
      "common",
      "word OR common",
      "rare common",
      "(rare OR uncommon) AND common",
      "(rare OR uncommon) /s common",
      '"rare common"',
      'common AND NOT "word noise"',
      "NOT rare",
      "common /s word",
      "rare AND NOT common",
    ];
    for (const name of ["full", "remote", "mixed"]) {
      const index = new BinaryIndex(
          await readFile(join(root, name, "bundle.bin")),
        ),
        store = new FileStorage(join(root, name, "objects")),
        runtime = new SearchRuntime(2 * 1024 * 1024);
      for (const field of ["all", "body", "title"] as const)
        for (const titleBoost of [0, 0.3, 2, 20])
          for (const q of queries) {
            const options = { field, titleBoost, limit: 7 };
            const a = await search(index, store, q, {
              ...options,
              planning: "legacy",
            });
            const b = await search(index, store, q, { ...options, runtime });
            const c = await search(index, store, q, {
              ...options,
              runtime,
              exactTotal: false,
            });
            expect(b.results, q).toEqual(a.results);
            expect(b.total, q).toBe(a.total);
            expect(c.results, q).toEqual(a.results);
            expect(c).not.toHaveProperty("total");
            expect(runtime.bytes).toBeLessThanOrEqual(runtime.capacity);
          }
      const broad = await search(index, store, "common", {
        exactTotal: false,
        runtime,
        limit: 7,
      });
      expect(broad.diagnostics.prunedCandidates).toBeGreaterThan(0);
      const h = handler(index, store, true, runtime);
      const response = await h(
        new Request(
          "https://test/search?q=common&total=false&diagnostics=true",
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("total");
      expect(
        (await h(new Request("https://test/search?q=common&total=invalid")))
          .status,
      ).toBe(400);
    }
    // Cache keys must isolate immutable generations, even for identical terms.
    const shared = new SearchRuntime(2 * 1024 * 1024),
      index = new BinaryIndex(
        await readFile(join(root, "remote", "bundle.bin")),
      ),
      store = new FileStorage(join(root, "remote", "objects"));
    const first = await search(index, store, "rare", { runtime: shared });
    const second = await search(
      index,
      {
        read: async () => {
          throw new Error("unexpected read");
        },
      },
      "rare",
      { runtime: shared },
    );
    expect(second.results).toEqual(first.results);
    expect(second.diagnostics.postingCacheHits).toBeGreaterThan(0);
    expect(second.diagnostics.indexRequests).toBe(0);
    expect(remote.bundleBytes).toBeLessThanOrEqual(remote.budget);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
