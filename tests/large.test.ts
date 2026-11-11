import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { reference } from "./reference.js";
it("merges multiple external-sort passes and preserves ranking and top-K", async () => {
  const root = await mkdtemp(join(tmpdir(), "search-merge-"));
  try {
    const docs = Array.from({ length: 150 }, (_, i) => ({
      id: `id${i}`,
      body: `common word${i % 17} word${i % 7} café`,
      title: `word${i % 5}`,
    }));
    const input = join(root, "input");
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const a = await build({ input, out: join(root, "a"), chunkDocs: 1 }),
      b = await build({ input, out: join(root, "b"), chunkDocs: 1000 });
    expect(await readFile(join(root, "a", "bundle.bin"))).toEqual(
      await readFile(join(root, "b", "bundle.bin")),
    );
    const idx = new BinaryIndex(await readFile(join(root, "a", "bundle.bin")));
    for (const mode of ["and", "or"] as const)
      for (const q of [
        "common",
        "word1 word2",
        "café word3",
        "missing word5",
      ]) {
        const got = await search(
          idx,
          new FileStorage(join(root, "a", "objects")),
          q,
          { mode, limit: 7 },
        );
        const expected = reference(docs, q, mode).slice(0, 7);
        expect(got.results.map((x) => x.id)).toEqual(expected.map((x) => x.id));
        got.results.forEach((x, i) =>
          expect(x.score).toBeCloseTo(expected[i].score),
        );
      }
    expect(a.bundleSha256).toBe(b.bundleSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
