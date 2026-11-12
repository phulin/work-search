import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGlobal } from "../src/global/build.js";
import { buildPairs } from "../src/global/pair-build.js";
import {
  PairFilter,
  decodePairRoot,
  encodePairDocs,
  encodePairEntry,
  decodePairEntry,
  encodePairRoot,
  decodePairDocs,
} from "../src/global/pairs.js";
import { decodeRoot } from "../src/global/format.js";
import { PageReader } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { GlobalIndex } from "../src/global/search.js";
import { tokenize } from "../src/query/tokenize.js";
import { parse } from "../src/query/parser.js";

it("round-trips delta pair documents including zero and large gaps", () => {
  expect(decodePairDocs(encodePairDocs([0, 1, 127, 128, 99999]))).toEqual([
    0, 1, 127, 128, 99999,
  ]);
  expect(() => decodePairDocs(encodePairDocs([1, 1]))).toThrow("Unsorted");
});
it("round-trips versioned binary inline/block pair entries", () => {
  for (const entry of [
    { df: 3, inlineDocs: [0, 128, 99999], blocks: [] },
    {
      df: 1,
      blocks: [
        {
          first: 7,
          last: 7,
          address: [0, 0, 25, 123, 5] as [
            number,
            number,
            number,
            number,
            number,
          ],
        },
      ],
    },
  ])
    expect(decodePairEntry(encodePairEntry(entry))).toEqual(entry);
  expect(() => decodePairEntry(Uint8Array.of(3))).toThrow("version");
});
it("selects corpus pairs, pins generation, respects fields and phrase boundaries, and conservatively handles Boolean nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pairs-"));
  try {
    const docs = [
      { id: "0", body: "red blue green" },
      { id: "1", body: "red blue gap blue green" },
      { id: "2", body: "red", title: "blue green" },
      { id: "3", body: "blue green red" },
      { id: "4", body: "echo echo" },
      { id: "5", body: "echo gap echo" },
      { id: "6", body: "red blue", title: "green" },
      { id: "7", body: "red gap blue gap green echo" },
      { id: "8", body: "CAFÉ naïve 東京" },
      { id: "9", body: "cafe\u0301 gap naïve 東京" },
      { id: "10", body: "cafe\u0301 gap naïve 東京", title: "CAFÉ naïve 東京" },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: "wide" + i,
        body:
          (i === 0 ? "singleton " : "") +
          (i < 20 ? "wide common" : "wide gap common"),
      })),
    ];
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await buildGlobal({
      input: dir + "/input",
      out: dir + "/base",
      micro: false,
      budgets: [1048576, 2097152],
      pageBytes: 65536,
    });
    const built = await buildPairs({
        input: dir + "/input",
        source: dir + "/base/source",
        base: dir + "/base",
        out: dir + "/pairs",
        minDf: 1,
        vocabulary: 32,
        budgetBytes: 1048576,
      }),
      base = decodeRoot(await readFile(dir + "/base/bundle-1.bin")).root,
      bytes = await readFile(dir + "/pairs/pairs.bin"),
      manifest = decodePairRoot(bytes, base),
      filter = new PairFilter(
        manifest,
        new PageReader(
          manifest.root,
          new FileStorage(dir + "/pairs/packs"),
          new SearchRuntime(0),
        ),
      );
    expect(built.totalBytes).toBeLessThanOrEqual(1048576);
    expect(await filter.candidates(["red", "blue"])).toEqual(
      new Set([0, 1, 6]),
    );
    // Pair occurrence is only a necessary condition; doc1 still needs full positional alignment.
    expect((await filter.candidates(["red", "blue", "green"]))?.has(1)).toBe(
      true,
    );
    expect(await filter.candidates(["echo", "echo"])).toEqual(new Set([4]));
    expect(await filter.candidates(["unknown", "pair"])).toBeUndefined();
    const multi = new PairFilter(manifest, filter.reader, 32768, true);
    expect(await multi.candidates(["red", "blue", "green"])).toEqual(
      new Set([0, 1]),
    );
    expect(
      await new PairFilter(manifest, filter.reader, 3, true).candidates([
        "red",
        "blue",
        "green",
      ]),
    ).toEqual(new Set([0, 1, 6]));
    const inlineBuilt = await buildPairs({
      input: dir + "/input",
      source: dir + "/base/source",
      base: dir + "/base",
      out: dir + "/inline",
      minDf: 1,
      vocabulary: 32,
      budgetBytes: 1048576,
      inlineRarePairs: true,
      maxRootBytes: 8192,
    });
    const inlineManifest = decodePairRoot(
        await readFile(dir + "/inline/pairs.bin"),
        base,
      ),
      inlineReader = new PageReader(
        inlineManifest.root,
        new FileStorage(dir + "/inline/packs"),
        new SearchRuntime(0),
      ),
      inlineFilter = new PairFilter(inlineManifest, inlineReader, 32768, true);
    expect(inlineBuilt.totalBytes).toBeLessThanOrEqual(1048576);
    expect(inlineBuilt.rootBytes).toBeLessThanOrEqual(8192);
    expect(inlineManifest.entryEncoding).toBe("binary-v2");
    expect(inlineBuilt.inlinePairs).toBeGreaterThan(0);
    expect(await inlineFilter.candidates(["red", "blue", "green"])).toEqual(
      new Set([0, 1]),
    );
    expect(inlineReader.rounds.map((round) => round.stage)).toEqual([
      "pair-dictionary",
    ]);
    inlineReader.clearTrace();
    expect((await inlineFilter.candidates(["wide", "common"]))?.size).toBe(20);
    expect(
      inlineReader.rounds.some((round) => round.stage === "pair-candidates"),
    ).toBe(true);
    inlineReader.clearTrace();
    expect(
      await inlineFilter.candidates(["singleton", "wide", "common"]),
    ).toEqual(new Set([11]));
    expect(inlineReader.rounds.map((round) => round.stage)).toEqual([
      "pair-dictionary",
    ]);
    expect(() =>
      decodePairRoot(
        encodePairRoot({ ...inlineManifest, entryEncoding: "unknown" as any }),
        base,
      ),
    ).toThrow("encoding");
    await expect(
      buildPairs({
        input: dir + "/input",
        source: dir + "/base/source",
        base: dir + "/base",
        out: dir + "/root-too-small",
        minDf: 1,
        vocabulary: 32,
        budgetBytes: 1048576,
        inlineRarePairs: true,
        maxRootBytes: 1,
      }),
    ).rejects.toThrow("root budget");
    await expect(
      readFile(dir + "/root-too-small/pairs.bin"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const pairs of [filter, multi, inlineFilter])
      expect(await pairs.candidates(tokenize("CAFE\u0301 NAÏVE 東京"))).toEqual(
        new Set([8, 10]),
      );
    const phrase = await filter.predicate(parse('"red blue"'));
    expect(phrase(2)).toBe(false);
    const disjunction = await filter.predicate(parse('"red blue" OR echo'));
    expect(disjunction(5)).toBe(true);
    const negated = await filter.predicate(parse('NOT "red blue"'));
    expect(negated(5)).toBe(true);
    const except = await filter.predicate(parse('echo NOT "red blue"'));
    expect(except(5)).toBe(true);
    expect(await filter.queryCandidates(parse(""))).toEqual(new Set());
    expect(
      await filter.queryCandidates(parse('red OR "red blue"')),
    ).toBeUndefined();
    expect(
      await new PairFilter(manifest, filter.reader, 1).candidates([
        "red",
        "blue",
      ]),
    ).toBeUndefined();
    for (const mib of [1, 2]) {
      const global = new GlobalIndex(
        await readFile(dir + "/base/bundle-" + mib + ".bin"),
      );
      const reader = new PageReader(
        global.root,
        {
          read: (key, o, n) =>
            new FileStorage(dir + "/base/packs").read(
              key.split("/").at(-1)!,
              o,
              n,
            ),
        },
        new SearchRuntime(0),
      );
      for (const query of [
        '"red blue green"',
        '"echo echo"',
        '"red blue" OR echo',
        'NOT "red blue"',
        'echo NOT "red blue"',
        '"red blue" AND green',
        '"red blue" OR "echo echo"',
        '"red blue" /2 green',
        '"CAFÉ naïve 東京"',
        '"cafe\u0301 naïve 東京"',
        '"CAFÉ naïve" OR "red blue"',
      ]) {
        for (const candidateFilter of [
          await filter.queryCandidates(parse(query)),
          await multi.queryCandidates(parse(query)),
          await inlineFilter.queryCandidates(parse(query)),
        ])
          for (const field of ["all", "title", "body"] as const)
            for (const adaptivePositions of [false, true]) {
              const options = {
                limit: 20,
                field,
                adaptivePositions,
                snippets: false,
                metadata: false,
              };
              const expected = await global.search(reader, query, options);
              const actual = await global.search(reader, query, {
                ...options,
                candidateFilter,
              });
              expect(
                actual.results.map((r: any) => [r.id, r.score]),
                query + field,
              ).toEqual(expected.results.map((r: any) => [r.id, r.score]));
            }
      }
    }
    expect(() =>
      decodePairRoot(bytes, { ...base, generation: "0".repeat(64) }),
    ).toThrow("generation");
    const corrupt = Uint8Array.from(bytes);
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => decodePairRoot(corrupt, base)).toThrow("checksum");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
