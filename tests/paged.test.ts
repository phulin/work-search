import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { pageIndex } from "../src/builder/page-index.js";
import { openIndex, decodeRoot, encodeRoot } from "../src/format/paged.js";
import { search } from "../src/query/engine.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { BinaryIndex, LOCAL } from "../src/format/index.js";
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
    // Descriptor hints must preserve inline-page access and bypass missing-term reads.
    const terms = ["court", "token4199"];
    const hints: Record<string, import("../src/format/index.js").Entry | null> =
      { missingword: null };
    for (const page of (paged as import("../src/format/paged.js").PagedIndex)
      .root.dictionary) {
      const bytes = await b.read(
        paged.key(0, "dictionary"),
        page.offset,
        page.length,
      );
      const dict = new BinaryIndex(bytes);
      for (const t of terms) {
        const e = dict.lookup(t);
        if (e) hints[t] = e;
      }
    }
    for (const q of [
      "court",
      "token4199",
      "court OR token4199",
      "court NOT missingword",
      '"court evidence"',
    ]) {
      const want = await search(paged, b, q);
      const got = await search(paged, b, q, { termHints: hints });
      expect(got.results, q).toEqual(want.results);
    }
    let missingReads = 0;
    const missing = await search(
      paged,
      {
        read: async () => {
          missingReads++;
          throw Error("Unexpected missing-term read");
        },
      },
      "missingword",
      { termHints: { missingword: null } },
    );
    expect(missing.results).toEqual([]);
    expect(missingReads).toBe(0);
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

it("bundles exact norms and compact IDs while keeping dictionary and metadata paged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hybrid-"));
  try {
    const docs = Array.from({ length: 4200 }, (_, i) => ({
      id: `判例:😀:${i}`,
      body: i % 3 ? "court summary judgment" : "court qualified immunity",
      title: "Title " + i,
      metadata: { i },
    }));
    await writeFile(
      join(dir, "docs"),
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await build({ input: join(dir, "docs"), out: join(dir, "old") });
    const manifest = await pageIndex(join(dir, "old"), join(dir, "hybrid"), {
      localTables: true,
    });
    expect(manifest.localNormBytes).toBe(4200 * 8);
    expect(manifest.localIdBytes).toBeGreaterThan(0);
    const bytes = await readFile(join(dir, "hybrid/bundle.bin")),
      hybrid = openIndex(bytes),
      old = openIndex(await readFile(join(dir, "old/bundle.bin"))),
      storage = new FileStorage(join(dir, "hybrid/objects")),
      a = new FileStorage(join(dir, "old/objects"));
    const reads: string[] = [];
    const tracked = {
      read: async (key: string, o: number, n: number) => {
        reads.push(key);
        return storage.read(key, o, n);
      },
    };
    await Promise.all(
      [
        "court summary",
        "court OR immunity",
        "(court AND judgment) OR immunity",
        '"summary judgment"',
        "court /25 judgment",
        "NOT immunity",
      ].map(async (q) => {
        const got = await search(hybrid, tracked, q);
        expect(got.results, q).toEqual(
          (await search(old, a, q, { exactTotal: true })).results,
        );
      }),
    );
    expect(
      reads.some((k) => k.includes("/norms-") || k.includes("/documents-")),
    ).toBe(false);
    for (const q of [
      "court OR immunity",
      "(court AND judgment) OR court",
      "court summary",
      '"summary judgment"',
    ])
      for (const pagedReadPolicy of ["fixed", "adaptive"] as const) {
        const actual = await search(hybrid, tracked, q, { pagedReadPolicy });
        expect(actual.results).toEqual(
          (await search(old, a, q, { exactTotal: true })).results,
        );
      }
    for (const field of ["all", "body", "title"] as const)
      for (const titleBoost of [0, 0.3, 20]) {
        const opts = { field, titleBoost, limit: 17 };
        expect(
          (await search(hybrid, tracked, "court OR immunity", opts)).results,
        ).toEqual(
          (
            await search(old, a, "court OR immunity", {
              ...opts,
              exactTotal: true,
            })
          ).results,
        );
      }
    const fixed = await search(hybrid, tracked, "court", {
        pagedReadPolicy: "fixed",
      }),
      adaptive = await search(hybrid, tracked, "court", {
        pagedReadPolicy: "adaptive",
      });
    expect(adaptive.results).toEqual(fixed.results);
    expect(adaptive.diagnostics.frequencyRequests).toBeLessThan(
      fixed.diagnostics.frequencyRequests,
    );
    const got = await search(hybrid, tracked, "court", {
      metadata: true,
      exactTotal: true,
    });
    expect(got.results).toEqual(
      (await search(old, a, "court", { metadata: true, exactTotal: true }))
        .results,
    );
    expect(reads.some((k) => k.includes("/documents-"))).toBe(true);
    await pageIndex(join(dir, "old"), join(dir, "again"), {
      localTables: true,
    });
    expect(await readFile(join(dir, "again/bundle.bin"))).toEqual(bytes);
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => openIndex(corrupt)).toThrow();
    await expect(
      pageIndex(join(dir, "old"), join(dir, "tiny"), {
        localTables: true,
        budget: 100,
      }),
    ).rejects.toThrow("budget");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
