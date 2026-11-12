import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { parse, queryTerms } from "../src/query/parser.js";
it("partition top-K merge uses global BM25 statistics and matches one full corpus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-"));
  try {
    const docs = Array.from({ length: 1200 }, (_, i) => ({
      id: "d" + i,
      body:
        i < 1000
          ? "court summary judgment evidence " + "court ".repeat(i % 30)
          : "standing jurisdiction " + "judgment ".repeat(i % 15),
      title: i % 2 ? "Court" : "Standing",
    }));
    const corpora = [docs, docs.slice(0, 1000), docs.slice(1000)];
    const indices = [];
    for (let i = 0; i < 3; i++) {
      const path = join(dir, String(i));
      await writeFile(
        path + ".jsonl",
        corpora[i].map((d) => JSON.stringify(d)).join("\n"),
      );
      await build({ input: path + ".jsonl", out: path });
      indices.push({
        index: openIndex(await readFile(path + "/bundle.bin")),
        storage: new FileStorage(path + "/objects"),
      });
    }
    for (const q of [
      "court judgment",
      "court OR standing",
      '"summary judgment"',
      "court /25 evidence",
      "court NOT standing",
      "(standing OR court) AND judgment",
    ]) {
      const terms = queryTerms(parse(q)),
        full = indices[0].index;
      const globalStats = {
        count: full.count,
        avgBody: full.avgBody,
        avgTitle: full.avgTitle,
        df: Object.fromEntries(terms.map((t) => [t, full.lookup(t)?.df ?? 0])),
      };
      const want = await search(full, indices[0].storage, q, {
        exactTotal: true,
      });
      const pieces = await Promise.all(
        indices.slice(1).map(({ index, storage }, shard) =>
          search(index, storage, q, { globalStats, internalDoc: true }).then(
            (r) =>
              r.results.map((h: any) => ({
                ...h,
                doc: h.doc + (shard ? 1000 : 0),
              })),
          ),
        ),
      );
      const got = pieces
        .flat()
        .sort((a, b) => b.score - a.score || a.doc - b.doc)
        .slice(0, 20)
        .map(({ doc, ...h }) => h);
      expect(got, q).toEqual(want.results);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
