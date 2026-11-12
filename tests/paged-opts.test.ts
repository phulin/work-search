import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { pageIndex } from "../src/builder/page-index.js";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { networkGroups } from "../src/query/ranges.js";
it("hot descriptors, embedded streams and inline rare postings preserve exact competitive connector results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paged-opts-"));
  try {
    const docs = Array.from({ length: 4200 }, (_, i) => ({
      id: `判例:${i}`,
      body: `court ${i % 3 ? "summary judgment" : "judgment summary"} evidence café token${i}`,
      title: i % 2 ? "Court" : "Judgment",
      metadata: { i },
    }));
    await writeFile(
      join(dir, "docs"),
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await build({ input: join(dir, "docs"), out: join(dir, "source") });
    const original = openIndex(await readFile(join(dir, "source/bundle.bin"))),
      base = new FileStorage(join(dir, "source/objects"));
    for (const step of [1, 2, 4, 6]) {
      const out = join(dir, String(step));
      await pageIndex(join(dir, "source"), out, {
        localTables: true,
        hotDescriptors: 8,
        embedPostings: step >= 2,
        inlineTiny: step >= 4,
        workload: ["court summary judgment", "evidence café"],
        optimizationStep: step,
      });
      const idx = openIndex(await readFile(out + "/bundle.bin")),
        storage = new FileStorage(out + "/objects");
      for (const q of [
        "court summary",
        "court OR judgment",
        '"summary judgment"',
        '"court evidence"',
        '"judgment summary"',
        "court /25 evidence",
        'NOT "summary judgment"',
        'court NOT "judgment summary"',
        '"summary judgment" OR café',
        "token4199",
        "token4199 /p court",
        "notfoundzz",
      ])
        for (const field of ["all", "body", "title"] as const) {
          const opts = { field, competitivePositions: true };
          expect((await search(idx, storage, q, opts)).results, q).toEqual(
            (await search(original, base, q, { field, exactTotal: true }))
              .results,
          );
        }
      if (step >= 2)
        expect(
          (await search(idx, storage, "court")).diagnostics.fullyLocal,
        ).toBe(true);
      if (step >= 4) {
        const got = await search(idx, storage, "token4199");
        expect(got.results[0].id).toBe("判例:4199");
        expect(got.diagnostics.frequencyRequests).toBe(0);
      }
      expect(
        (
          await search(idx, storage, "court", {
            metadata: true,
            exactTotal: true,
          })
        ).results,
      ).toEqual(
        (
          await search(original, base, "court", {
            metadata: true,
            exactTotal: true,
          })
        ).results,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
it("network range planning accounts for shared read waves and transfer cost", () => {
  const extent = (i: number) => ({ start: i * 1000, end: i * 1000 + 10 });
  expect(
    networkGroups([0, 1, 2], extent, {
      latencyMs: 20,
      bandwidthMiB: 100,
      lanes: 1,
    }),
  ).toEqual([[0, 1, 2]]);
  expect(
    networkGroups([0, 1, 2], extent, {
      latencyMs: 20,
      bandwidthMiB: 1,
      lanes: 4,
    }),
  ).toEqual([[0], [1], [2]]);
  expect(
    networkGroups([], extent, { latencyMs: 20, bandwidthMiB: 50, lanes: 1 }),
  ).toEqual([]);
});
