import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGlobal } from "../src/global/build.js";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { planWindows } from "../src/global/windows.js";
import { parse } from "../src/query/parser.js";
it("requires a positive, mandatory bounded positional anchor", () => {
  const plans = new Map([
    ["rare", { df: 1 }],
    ["common", { df: 100 }],
  ]) as Parameters<typeof planWindows>[1];
  expect(planWindows(parse('"common rare"'), plans, "body")?.anchor).toBe(
    "rare",
  );
  for (const q of [
    'other OR "common rare"',
    'common NOT "common rare"',
    'NOT "common rare"',
    '"rare common" AND NOT "common rare"',
    "rare /200 common",
  ])
    expect(planWindows(parse(q), plans, "all"), q).toBeUndefined();
  expect(planWindows(parse('"rare common"'), plans, "title")).toBeUndefined();
});
it("verifies token frames exactly, falls back across frame edges and preserves Unicode and pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "windows-"));
  try {
    const docs = Array.from({ length: 160 }, (_, i) => ({
      id: "d" + i,
      title: i === 4 ? "rare common" : "caption",
      body:
        "common ".repeat(i === 1 ? 511 : 100) +
        (i < 5 ? "rare common İSTANBUL ΣΟΣ " : "") +
        "common ".repeat(1200),
      metadata: { i },
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const built = await buildGlobal({
      input: dir + "/input",
      out: dir + "/index",
      budgets: [1048576],
      pageBytes: 65536,
    });
    const index = new GlobalIndex(
      await readFile(dir + "/index/" + built.roots[0].name),
    );
    const disk = new FileStorage(dir + "/index/packs");
    const reader = () =>
      new PageReader(
        index.root,
        { read: (k, o, n) => disk.read(k.split("/").at(-1)!, o, n) },
        new SearchRuntime(0),
      );
    let used = 0;
    for (const q of [
      '"rare common"',
      "rare /5 common",
      '"İSTANBUL ΣΟΣ"',
      '"rare common" AND common',
      'common NOT "rare common"',
    ])
      for (const field of ["body", "all", "title"] as const) {
        const opts = { field, limit: 3, metadata: false, snippets: false };
        const want = await index.search(reader(), q, {
          ...opts,
          tokenWindows: false,
        });
        const got = await index.search(reader(), q, {
          ...opts,
          tokenWindows: true,
        });
        expect(got.results, q + field).toEqual(want.results);
        used += got.diagnostics.windowDocuments ?? 0;
        const last = got.results.at(-1);
        if (last) {
          const after = { score: last.score, doc: last.doc };
          expect(
            (
              await index.search(reader(), q, {
                ...opts,
                after,
                tokenWindows: true,
              })
            ).results,
            q + field + "/after",
          ).toEqual(
            (await index.search(reader(), q, { ...opts, after })).results,
          );
        }
      }
    expect(used).toBeGreaterThan(0);
    const display = await index.search(reader(), '"rare common"', {
      tokenWindows: true,
      field: "body",
      limit: 1,
    });
    expect(display.results[0].excerpt).toContain("rare common");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
