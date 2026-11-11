import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { pageIndex } from "../src/builder/page-index.js";
import { openIndex, decodeRoot, encodeRoot } from "../src/format/paged.js";
import { search } from "../src/query/engine.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
it("paged R2 dictionary, norms and results preserve exact terms/connectors, fields and totals with isolated concurrent queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paged-"));
  try {
    const docs = Array.from({ length: 4200 }, (_, i) => ({
      id: `case-${i}`,
      body: `court evidence ${i % 3 ? "summary judgment" : "qualified immunity"} café token${i}`,
      title: i % 2 ? "Summary" : "Evidence",
      metadata: { i },
    }));
    await writeFile(
      join(dir, "corpus"),
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await build({ input: join(dir, "corpus"), out: join(dir, "old") });
    await pageIndex(join(dir, "old"), join(dir, "new"));
    const old = openIndex(await readFile(join(dir, "old/bundle.bin"))),
      paged = openIndex(await readFile(join(dir, "new/bundle.bin"))),
      a = new FileStorage(join(dir, "old/objects")),
      b = new FileStorage(join(dir, "new/objects")),
      runtime = new SearchRuntime();
    const queries = [
      "court evidence",
      "summary OR immunity",
      "(summary AND judgment) OR immunity",
      '"summary judgment"',
      "summary /25 evidence",
      "café",
      "missingword",
      "NOT immunity",
      "court NOT immunity",
      "token4199",
    ];
    await Promise.all(
      queries.map(async (q) => {
        for (const field of ["all", "title", "body"] as const) {
          const options = { field, exactTotal: true, metadata: true, runtime };
          const want = await search(old, a, q, options);
          const got = await search(paged, b, q, options);
          expect(got.results, q).toEqual(want.results);
          expect(got.total, q).toBe(want.total);
        }
      }),
    );
    runtime.clear();
    for (const q of [
      "court OR evidence",
      "(court AND evidence) OR court",
      "summary AND judgment",
      "summary OR immunity",
    ])
      for (const executor of ["auto", "boolean", "wand"] as const) {
        const want = await search(old, a, q, { exactTotal: true, limit: 7 });
        const got = await search(paged, b, q, { executor, limit: 7 });
        expect(got.results, q + executor).toEqual(want.results);
      }
    runtime.clear();
    const cold = await search(paged, b, "court"),
      warm = await search(paged, b, "court", { runtime });
    const hot = await search(paged, b, "court", { runtime });
    expect(hot.results).toEqual(cold.results);
    expect(hot.diagnostics.indexRequests).toBeLessThan(
      warm.diagnostics.indexRequests,
    );
    const bytes = await readFile(join(dir, "new/bundle.bin"));
    const root = decodeRoot(bytes);
    expect(() =>
      decodeRoot(encodeRoot({ ...root, version: 2 } as any)),
    ).toThrow();
    expect(() =>
      decodeRoot(encodeRoot({ ...root, documentSize: 1024 })),
    ).toThrow();
    await pageIndex(join(dir, "old"), join(dir, "repeat"));
    expect(await readFile(join(dir, "repeat/bundle.bin"))).toEqual(bytes);
    bytes[bytes.length - 1] ^= 1;
    expect(() => decodeRoot(bytes)).toThrow();
    let reads = 0;
    await expect(
      search(
        paged,
        {
          read: async (key, o, n) => {
            reads++;
            const bytes = await b.read(key, o, n);
            bytes[0] ^= 1;
            return bytes;
          },
        },
        "court",
      ),
    ).rejects.toThrow();
    expect(reads).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
