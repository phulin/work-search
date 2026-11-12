import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGlobal, tokenOffsets } from "../src/global/build.js";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import {
  Dictionary,
  encodeDictionary,
  decodeRoot,
} from "../src/global/format.js";
import { search } from "../src/query/engine.js";
import { BinaryIndex } from "../src/format/index.js";
import { tokenize } from "../src/query/tokenize.js";
import { SearchRuntime } from "../src/query/runtime.js";
it("front codes Unicode dictionaries without splitting surrogate pairs", () => {
  const entries = ["", "a", "é", "法", "𐐀", "𐐁", "𐐂x", "😀"]
    .sort()
    .map((t, i) => [t, Uint8Array.of(i)] as [string, Uint8Array]);
  const d = new Dictionary(encodeDictionary(entries));
  for (const [k, v] of entries) expect(d.lookup(k)).toEqual(v);
  expect(d.lookup("absent")).toBeUndefined();
  for (const s of ["¼² İSTANBUL ΣΟΣ e\u0301 ﬃ 法律", "Plain text.", "𐐀 one"])
    expect(tokenOffsets(s).terms).toEqual(tokenize(s));
});
it("matches the existing engine for Boolean, phrase, proximity, fields, seeds, ties and search-after across budgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-"));
  try {
    const docs = Array.from({ length: 2200 }, (_, i) => ({
      id: "d" + i,
      title: i % 3 ? "Legal court" : "Rare caption",
      body:
        (i % 7
          ? "summary judgment evidence court "
          : "qualified immunity prison ") +
        (i % 11 ? "" : "clear and convincing evidence ") +
        "long ".repeat(i % 90) +
        (i === 890
          ? "café rareunique marker " +
            "padding ".repeat(700) +
            "lateunique tail"
          : ""),
      metadata: { court: "test", n: i },
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const built = await buildGlobal({
      input: dir + "/input",
      out: dir + "/index",
      budgets: [0.05 * 1048576, 2 * 1048576],
      pageBytes: 65536,
    });
    const source = new BinaryIndex(
        await readFile(dir + "/index/source/bundle.bin"),
      ),
      disk = new FileStorage(dir + "/index/source/objects");
    for (const bundle of built.roots) {
      const global = new GlobalIndex(
          await readFile(dir + "/index/" + bundle.name),
        ),
        reader = new PageReader(
          global.root,
          {
            read: (key, o, n) =>
              new FileStorage(dir + "/index/packs").read(
                key.split("/").at(-1)!,
                o,
                n,
              ),
          },
          new SearchRuntime(0),
        );
      for (const q of [
        "summary judgment",
        "court",
        "rareunique",
        "rareunique court",
        "missing",
        "missing AND court",
        "summary OR qualified",
        "(summary OR qualified) AND evidence",
        "qualified NOT prison",
        "NOT missing",
        "NOT court",
        '"clear and convincing evidence"',
        "qualified /s prison",
        "summary /2 judgment",
        "court OR NOT summary",
        'court OR NOT "summary judgment"',
        '"summary judgment" OR "qualified immunity"',
        'court NOT "qualified immunity"',
        '"court summary" OR evidence',
        '"summary judgment" /5 court',
        "court /2 court",
        'NOT "court summary"',
      ]) {
        for (const field of ["all", "body", "title"] as const) {
          const expected = await search(source, disk, q, {
            limit: 20,
            field,
            internalDoc: true,
            metadata: false,
          });
          const got = await global.search(reader, q, {
            limit: 20,
            field,
            metadata: true,
            snippets: true,
          });
          expect(
            got.results.map((r: any) => r.id),
            q + field,
          ).toEqual(expected.results.map((r) => r.id));
          got.results.forEach((r: any, i: number) =>
            expect(r.score, q).toBeCloseTo(expected.results[i].score, 9),
          );
        }
      }
      for (const q of [
        '"summary judgment"',
        "court /2 judgment",
        'court OR NOT "summary judgment"',
        '"summary judgment" OR "qualified immunity"',
        'NOT "court summary"',
        'court NOT "summary court"',
      ]) {
        for (const field of ["all", "body", "title"] as const) {
          for (const titleBoost of [0, 2, 7]) {
            const options = {
              field,
              titleBoost,
              limit: 20,
              metadata: false,
              snippets: false,
            };
            const expected = await global.search(reader, q, {
              ...options,
              adaptivePositions: false,
            });
            for (const execution of [
              { adaptivePositions: false },
              {
                adaptivePositions: true,
                adaptiveProbe: "competitive",
                tokenWindows: true,
                cofetchPositions: true,
              },
              {
                adaptivePositions: true,
                adaptiveProbe: "competitive",
                tokenWindows: true,
              },
              { adaptivePositions: true, adaptiveProbe: "competitive" },
              { adaptivePositions: true, adaptiveProbe: "fused" },
            ] as const) {
              const got = await global.search(reader, q, {
                ...options,
                competitivePositions: true,
                ...execution,
              });
              if (got.diagnostics.adaptiveProbe !== "fused")
                expect(got.diagnostics.competitivePositions, q).toBe(true);
              expect(
                got.results,
                q + field + titleBoost + JSON.stringify(execution),
              ).toEqual(expected.results);
              if (got.results.length) {
                const last = got.results.at(-1)!;
                const after = { score: last.score, doc: last.doc };
                const next = await global.search(reader, q, {
                  ...options,
                  after,
                  adaptivePositions: false,
                });
                const gotNext = await global.search(reader, q, {
                  ...options,
                  after,
                  competitivePositions: true,
                  ...execution,
                });
                expect(gotNext.results, q + " after").toEqual(next.results);
              }
            }
          }
        }
      }
      const filteredQuery = '"summary judgment"';
      const allMatches = new Set(
        docs.flatMap((d, i) =>
          d.body.includes("summary judgment") ? [i] : [],
        ),
      );
      const unfiltered = await global.search(reader, filteredQuery);
      const filtered = await global.search(reader, filteredQuery, {
        candidateFilter: allMatches,
      });
      expect(filtered.results).toEqual(unfiltered.results);
      expect(unfiltered.diagnostics.positionalOrder).toBe("score");
      const fusedDense = await global.search(reader, filteredQuery, {
        adaptiveProbe: "fused",
      });
      const fusedDenseBaseline = await global.search(reader, filteredQuery, {
        adaptivePositions: false,
      });
      expect(fusedDense.results).toEqual(fusedDenseBaseline.results);
      expect(fusedDense.diagnostics.competitivePositions).toBe(false);
      expect(fusedDense.diagnostics.positionalOrder).toBe("score");
      expect(fusedDense.diagnostics.requests).toBe(
        fusedDenseBaseline.diagnostics.requests,
      );
      expect(fusedDense.diagnostics.indexRounds).toBe(
        fusedDenseBaseline.diagnostics.indexRounds,
      );
      const fusedSparse = await global.search(reader, '"court summary"', {
        adaptiveProbe: "fused",
        batchTiles: 1,
      });
      expect(fusedSparse.results).toEqual([]);
      expect(fusedSparse.diagnostics.competitivePositions).toBe(true);
      expect(fusedSparse.diagnostics.positionalOrder).toBe("document");
      const sparse = await global.search(reader, '"court summary"');
      expect(sparse.results).toEqual([]);
      expect(sparse.diagnostics.positionalOrder).toBe("document");
      const emptyFiltered = await global.search(reader, filteredQuery, {
        candidateFilter: new Set(),
      });
      expect(emptyFiltered.results).toEqual([]);
      const first = await global.search(reader, "court", {
        metadata: false,
        snippets: false,
      });
      expect(first.diagnostics.seedProof).toBe(true);
      expect(first.diagnostics.requests).toBe(0);
      const last = first.results.at(-1)!;
      const second = await global.search(reader, "court", {
        after: { score: last.score, doc: last.doc },
      });
      expect(
        second.results.some((h: any) =>
          first.results.some((r: any) => r.id === h.id),
        ),
      ).toBe(false);
      const phrase = await global.search(reader, '"lateunique tail"');
      expect(phrase.results[0].excerpt).toContain("lateunique tail");
      expect(phrase.diagnostics.rounds.at(-1)?.stage).toBe(
        "results-and-passages",
      );
      const heads = new GlobalIndex(
        await readFile(dir + "/index/" + bundle.displayName),
      );
      const local = await heads.search(
        new PageReader(heads.root, {
          read: async () => {
            throw Error("Unexpected full-head storage read");
          },
        }),
        "court",
      );
      expect(local.results).toHaveLength(20);
      expect(local.diagnostics.requests).toBe(0);
      expect(local.results[0].metadata).toMatchObject({ court: "test" });
      const bytes = await readFile(dir + "/index/" + bundle.name);
      bytes[bytes.length - 1] ^= 1;
      expect(() => decodeRoot(bytes)).toThrow(/checksum/);
    }
    const again = await buildGlobal({
      input: dir + "/input",
      out: dir + "/repeat",
      source: dir + "/index/source",
      budgets: [2 * 1048576],
      pageBytes: 65536,
    });
    expect(again.generation).toBe(built.generation);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

it("preserves document-order ties when hot seeds are concentrated in later blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-ties-"));
  try {
    const docs = Array.from({ length: 6000 }, (_, doc) => ({
      id: "d" + doc,
      title: "alpha beta",
      body:
        doc >= 1024 && doc < 5120 && doc % 128 === 0
          ? "alpha ".repeat(5) + "beta"
          : doc >= 1024 && doc < 5120 && doc % 128 === 64
            ? "beta ".repeat(5) + "alpha"
            : "alpha beta",
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await buildGlobal({
      input: dir + "/input",
      out: dir + "/index",
      budgets: [1048576],
    });
    for (const name of ["bundle-1.bin", "bundle-heads-1.bin"]) {
      const index = new GlobalIndex(await readFile(dir + "/index/" + name)),
        disk = new FileStorage(dir + "/index/packs"),
        reader = new PageReader(index.root, {
          read: (key, o, n) => disk.read(key.split("/").at(-1)!, o, n),
        });
      for (const start of [0, 20]) {
        const result = await index.search(reader, "alpha OR beta", {
          field: "title",
          titleBoost: 0,
          batchTiles: 1,
          metadata: false,
          snippets: false,
          after: start ? { score: 0, doc: start - 1 } : undefined,
        });
        expect(result.results.map((r: any) => r.id)).toEqual(
          Array.from({ length: 20 }, (_, i) => "d" + (start + i)),
        );
        expect(result.results.every((r: any) => r.score === 0)).toBe(true);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
