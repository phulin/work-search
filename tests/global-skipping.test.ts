import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { globalBound } from "../src/query/block-search.js";
import { SearchRuntime } from "../src/query/runtime.js";
it("conservatively rescales local BM25 bounds for extreme global averages and IDF", () => {
  for (const tf of [1, 2, 10, 10000])
    for (const dl of [0, 1, 100, 1e8])
      for (const localAvg of [0.01, 1, 100, 1e6])
        for (const avg of [0.01, 1, 100, 1e6]) {
          const local = (2.2 * tf) / (tf + 0.3 + (0.9 * dl) / localAvg),
            global = (7 * 2.2 * tf) / (tf + 0.3 + (0.9 * dl) / avg);
          expect(
            globalBound(local, 1, 7, localAvg, avg),
          ).toBeGreaterThanOrEqual(global);
        }
});
it("global Boolean and WAND blocks preserve exact rankings, fields, ties and search-after", async () => {
  const root = await mkdtemp(join(tmpdir(), "global-skips-"));
  try {
    const docs = Array.from({ length: 4096 }, (_, i) => ({
      id: "d" + i,
      title: i % 3 ? "alpha beta" : "gamma",
      body:
        "alpha ".repeat(1 + (i % 13)) +
        (i % 5 ? "beta " : "") +
        (i % 31 === 0 ? "gamma " : "") +
        "filler ".repeat(i % 71),
    }));
    await writeFile(
      root + "/docs",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await build({ input: root + "/docs", out: root + "/index" });
    const index = openIndex(await readFile(root + "/index/bundle.bin")),
      storage = new FileStorage(root + "/index/objects"),
      runtime = new SearchRuntime();
    for (const factor of [0.01, 1, 100])
      for (const q of [
        "alpha beta",
        "alpha OR gamma",
        "(alpha OR gamma) AND beta",
      ]) {
        const globalStats = {
          count: 123456,
          avgBody: index.avgBody * factor,
          avgTitle: index.avgTitle / factor,
          df: { alpha: 100000, beta: 20000, gamma: 5000 },
        };
        for (const field of ["all", "body", "title"] as const) {
          const options = {
            globalStats,
            field,
            limit: 21,
            internalDoc: true,
            runtime,
          };
          const want = await search(index, storage, q, {
            ...options,
            runtime: undefined,
            executor: "materialized",
          });
          for (const executor of ["boolean", "wand"] as const) {
            const got = await search(index, storage, q, {
              ...options,
              executor,
              globalSkipping: true,
            });
            expect(got.results, `${q}/${field}/${factor}/${executor}`).toEqual(
              want.results,
            );
            expect(got.diagnostics.executor).not.toBe("materialized");
            const last: any = got.results.at(-1),
              after = { score: last.score, doc: last.doc };
            const page = await search(index, storage, q, {
              ...options,
              executor,
              globalSkipping: true,
              after,
            });
            expect(page.results).toEqual(
              (
                await search(index, storage, q, {
                  ...options,
                  runtime: undefined,
                  executor: "materialized",
                  after,
                })
              ).results,
            );
          }
        }
      }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
