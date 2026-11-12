import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGlobal } from "../src/global/build.js";
import { addMicroPlans } from "../src/global/micro.js";
import { addDisplaySeeds } from "../src/global/display.js";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader, pageName } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import {
  decodeTerm,
  encodeTerm,
  encodeDictionary,
  encodeRoot,
  type Term,
} from "../src/global/format.js";
it("versions score-window geometry and rejects unsupported cell sizes", () => {
  const t: Term = {
    df: 1,
    blocks: [],
    omitted: 0,
    omittedDoc: 0,
    windows: [[0, 1]],
    windowDocs: 16,
  };
  expect(decodeTerm(encodeTerm(t))).toEqual({
    ...t,
    inline: new Uint8Array(),
    inlinePositions: new Uint8Array(),
    seeds: new Uint8Array(),
  });
  expect(() => encodeTerm({ ...t, windowDocs: 7 })).toThrow("geometry");
  const b = encodeTerm(t);
  b[b.length - 1] = 7;
  expect(() => decodeTerm(b)).toThrow("geometry");
});
it("refines exact bounds without changing postings, keeps mixed geometries conservative, and completes negative/OR seeds exactly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fine-"));
  try {
    const docs = Array.from({ length: 2600 }, (_, i) => ({
      id: "d" + i,
      title: i % 3 ? "alpha beta" : "gamma",
      body:
        "alpha ".repeat(1 + (i % 7)) +
        (i % 5 ? "beta " : "") +
        (i % 11 ? "" : "gamma ") +
        "filler ".repeat(i % 71),
    }));
    await writeFile(
      dir + "/docs",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const built = await buildGlobal({
      input: dir + "/docs",
      out: dir + "/index",
      budgets: [1048576],
      pageBytes: 65536,
    });
    const old = new GlobalIndex(
      await readFile(dir + "/index/bundle-heads-1.bin"),
    );
    const before = await readFile(
      dir + "/index/packs/" + old.root.objects[0].name,
    );
    await addMicroPlans(dir + "/index", 16);
    await addDisplaySeeds(dir + "/index", 4096);
    const fine = new GlobalIndex(
      await readFile(dir + "/index/bundle-heads-1.bin"),
    );
    expect(fine.bundleBytes + 4096).toBeLessThanOrEqual(1048576);
    expect(
      await readFile(dir + "/index/packs/" + old.root.objects[0].name),
    ).toEqual(before);
    expect(fine.root.objects.slice(0, old.root.objects.length)).toEqual(
      old.root.objects,
    );
    const added = fine.root.objects.length - 1;
    expect(fine.root.objects[added].name).toMatch(/-[a-f0-9]{16}\.bin$/);
    const other = {
      ...fine.root,
      objects: fine.root.objects.map((o, i) =>
        i === added ? { ...o, sha256: "f".repeat(64) } : o,
      ),
    };
    expect(pageName(fine.root, added, 0)).not.toBe(pageName(other, added, 0));
    const entries = [...fine.hot.entries()];
    const alpha = entries.findIndex(([t]) => t === "alpha");
    entries[alpha] = ["alpha", old.hot.lookup("alpha")!];
    const mixed = new GlobalIndex(
      encodeRoot(fine.root, encodeDictionary(entries)),
    );
    const disk = new FileStorage(dir + "/index/packs");
    const reader = (idx: GlobalIndex) =>
      new PageReader(
        idx.root,
        { read: (k, o, n) => disk.read(k.split("/").at(-1)!, o, n) },
        new SearchRuntime(0),
      );
    for (const q of [
      "alpha beta",
      "(alpha OR gamma) AND beta",
      "alpha NOT gamma",
      "alpha OR absent",
      '"alpha beta"',
      "alpha /5 beta",
      "gamma /5 beta",
    ])
      for (const field of ["all", "body", "title"] as const)
        for (const titleBoost of [0, 2, 7]) {
          const options = {
            field,
            titleBoost,
            limit: 21,
            metadata: false,
            snippets: false,
          };
          const want = await old.search(reader(old), q, options);
          for (const index of [fine, mixed]) {
            const got = await index.search(reader(index), q, {
              ...options,
              completeSeeds: true,
              adaptiveRetrieval: true,
              cofetchPositions: true,
              tokenWindows: true,
            });
            expect(got.results, q + field + titleBoost).toEqual(want.results);
            const last = got.results.at(-1);
            if (last) {
              const after = { doc: last.doc, score: last.score };
              expect(
                (
                  await index.search(reader(index), q, {
                    ...options,
                    completeSeeds: true,
                    adaptiveRetrieval: true,
                    after,
                  })
                ).results,
                q +
                  field +
                  titleBoost +
                  "/after/" +
                  (index === fine ? "fine" : "mixed"),
              ).toEqual(
                (await old.search(reader(old), q, { ...options, after }))
                  .results,
              );
            }
          }
        }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
