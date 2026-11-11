import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { search as reference } from "../bench/baseline-next.js";
import { SearchRuntime } from "../src/query/runtime.js";
it("Boolean trees and WAND preserve exact scoring, duplicates, fields, ties, boosts and top-K", async () => {
  const root = await mkdtemp(join(tmpdir(), "wand-"));
  try {
    let seed = 1234567;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const docs = Array.from({ length: 3073 }, (_, i) => ({
      id: `doc-${i}`,
      body:
        "common " +
        "alpha ".repeat(Math.floor(rand() * 6)) +
        (i % 7 ? "beta " : "rare ".repeat(8)) +
        (i % 13 ? "gamma " : "delta ") +
        "filler ".repeat(Math.floor(rand() * 40)),
      title: i % 3 ? "common alpha" : "beta rare gamma",
    }));
    const input = join(root, "input");
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const full = await build({ input, out: root + "/full", budget: 1000000 });
    const mandatory = full.bundleBytes - full.embeddedBytes;
    await build({ input, out: root + "/remote", budget: mandatory });
    const queries = [
      "common OR rare",
      "common OR rare OR beta",
      "(rare OR beta) AND gamma",
      "(alpha AND beta) OR alpha",
      "(common AND rare) OR (common AND beta)",
      "(alpha OR beta) AND (alpha OR gamma)",
      "(alpha AND beta) OR (gamma AND rare)",
      "common AND rare",
      "alpha OR alpha OR beta",
      "(common OR rare) AND NOT gamma",
      '"alpha alpha"',
      "rare /25 common",
    ];
    for (const layout of ["full", "remote"]) {
      const index = new BinaryIndex(
          await readFile(root + "/" + layout + "/bundle.bin"),
        ),
        store = new FileStorage(root + "/" + layout + "/objects");
      for (const q of queries)
        for (const [field, titleBoost, limit] of [
          ["all", 0, 1],
          ["all", 0.3, 7],
          ["all", 1.0000000000000002, 7],
          ["all", 2, 20],
          ["body", 20, 100],
          ["title", 2, 7],
          ["title", 20, 20],
        ] as const) {
          const expected = await reference(index, store, q, {
            exactTotal: true,
            field,
            titleBoost,
            limit,
          });
          for (const executor of ["auto", "boolean", "wand"] as const) {
            const actual = await search(index, store, q, {
              executor,
              field,
              titleBoost,
              limit,
            });
            expect(
              actual.results,
              `${layout}/${q}/${executor}/${field}/${titleBoost}/${limit}`,
            ).toEqual(expected.results);
            expect(actual).not.toHaveProperty("total");
          }
        }
      const makeTree = (depth: number): string =>
        depth === 0
          ? ["common", "alpha", "beta", "gamma", "rare"][Math.floor(rand() * 5)]
          : `(${makeTree(depth - 1)} ${rand() < 0.5 ? "AND" : "OR"} ${makeTree(depth - 1)})`;
      for (let trial = 0; trial < 100; trial++) {
        const q = makeTree(1 + (trial % 3)),
          titleBoost = [0, 0.1, 1.0000000000000002, 20][trial % 4],
          field = (["all", "body", "title"] as const)[trial % 3];
        const expected = await reference(index, store, q, {
          exactTotal: true,
          titleBoost,
          field,
          limit: 1 + (trial % 20),
        });
        for (const executor of ["boolean", "wand"] as const) {
          const r = await search(index, store, q, {
            executor,
            titleBoost,
            field,
            limit: 1 + (trial % 20),
          });
          expect(r.results, q).toEqual(expected.results);
        }
      }
      const runtime = new SearchRuntime();
      const q = "(common AND rare) OR (common AND beta)";
      const fullCached = await search(index, store, q, {
        exactTotal: true,
        runtime,
      });
      for (const executor of ["boolean", "wand"] as const) {
        const r = await search(
          index,
          {
            read: async () => {
              throw Error("Unexpected cached read");
            },
          },
          q,
          { executor, runtime },
        );
        expect(r.results).toEqual(fullCached.results);
        expect(r.diagnostics.fullPostingCacheHits).toBeGreaterThan(0);
        expect(r.diagnostics.indexRequests).toBe(0);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
it("pivot WAND skips low-impact postings and Boolean AND drives only its selective union", async () => {
  const root = await mkdtemp(join(tmpdir(), "wand-skip-"));
  try {
    const input = root + "/input";
    await writeFile(
      input,
      Array.from({ length: 8193 }, (_, i) =>
        JSON.stringify({
          id: String(i),
          body:
            "common " +
            (i % 19 === 0 ? "rare rare rare " : i % 41 === 0 ? "other " : "") +
            "padding ".repeat(i % 4) +
            Array.from({ length: 16 }, (_, j) =>
              i % (j + 2) === 0 ? ` term${j}` : "",
            ).join(""),
        }),
      ).join("\n"),
    );
    await build({ input, out: root + "/index", budget: 1000000 });
    const index = new BinaryIndex(await readFile(root + "/index/bundle.bin")),
      store = new FileStorage(root + "/index/objects");
    const w = await search(index, store, "common OR rare", {
      executor: "wand",
      limit: 7,
    });
    const expected = await reference(index, store, "common OR rare", {
      exactTotal: true,
      limit: 7,
    });
    expect(w.results).toEqual(expected.results);
    expect(w.diagnostics.wandPivots).toBeGreaterThan(0);
    expect(w.diagnostics.wandSkips).toBeGreaterThan(0);
    expect(w.diagnostics.visitedDocuments).toBeLessThan(8193 / 2);
    for (const size of [4, 8, 16]) {
      const q = Array.from({ length: size }, (_, j) => `term${j}`).join(" OR ");
      const a = await search(index, store, q, {
        executor: "wand",
        titleBoost: 0.1,
        limit: 7,
      });
      expect(a.results).toEqual(
        (
          await reference(index, store, q, {
            exactTotal: true,
            titleBoost: 0.1,
            limit: 7,
          })
        ).results,
      );
    }
    const b = await search(index, store, "(rare OR other) AND common", {
      executor: "boolean",
    });
    expect(b.results).toEqual(
      (
        await reference(index, store, "(rare OR other) AND common", {
          exactTotal: true,
        })
      ).results,
    );
    expect(b.diagnostics.visitedDocuments).toBeLessThan(8193 / 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
