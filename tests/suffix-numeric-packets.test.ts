import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildSuffixIndex } from "../scripts/suffix-builder.js";
import { encodeSuffixFences } from "../src/suffix/fences.js";
import {
  baseColumns,
  encodeNumericBase,
  decodeNumericBase,
  NumericDirectoryBuilder,
  NumericDirectory,
} from "../src/suffix/numeric-packets.js";
import { SuffixReader, SuffixMemory } from "../src/suffix/reader.js";
import { rankSuffix } from "../src/suffix/rank.js";
import { rankSuffixConjunction } from "../src/suffix/boolean-rank.js";
import { bm25 } from "../src/query/engine.js";
import type {
  SuffixBlock,
  SuffixManifest,
  FixedScores,
} from "../src/suffix/format.js";

it("bounds shared suffix memory across cold request namespaces and rejects another generation", async () => {
  const generation = "a".repeat(64),
    memory = new SuffixMemory(generation),
    manifest = {
      format: "word-suffix-1",
      generation,
      fixed: { titleBoost: 2 },
    } as SuffixManifest;
  let reads = 0;
  const source = async () => {
      reads++;
      return Uint8Array.of(1, 2, 3);
    },
    first = new SuffixReader(manifest, source, undefined, { memory }),
    second = new SuffixReader(manifest, source, undefined, { memory }),
    cold = new SuffixReader(manifest, source, undefined, {
      memory: memory.scoped("different-request"),
    });
  expect(await first.read("example", 0, 3, false)).toEqual(
    Uint8Array.of(1, 2, 3),
  );
  await second.read("example", 0, 3, false);
  expect(reads).toBe(1);
  await cold.read("example", 0, 3, false);
  expect(reads).toBe(2);
  expect(
    () =>
      new SuffixReader(
        { ...manifest, generation: "b".repeat(64) },
        source,
        undefined,
        { memory },
      ),
  ).toThrow("generation mismatch");
  const buffer = new Uint8Array(2 * 1048576);
  for (let i = 0; i < 8; i++)
    memory.scoped(String(i)).columns.set("large", buffer, buffer.length);
  expect(memory.columns.bytes).toBeLessThanOrEqual(8 * 1048576);
  expect(memory.scoped("0").columns.get("large")).toBeUndefined();
  expect(memory.scoped("7").columns.get("large")).toBe(buffer);
});

it("routes wide numeric addresses across restarts and rejects incomplete or mismatched generations", () => {
  const corpus = "a".repeat(64),
    offsets = Array(4).fill(2 ** 36),
    expected: number[][] = [],
    builder = new NumericDirectoryBuilder(150, corpus, 1050);
  let total = 0;
  for (let i = 0; i < 150; i++) {
    expected.push([total, ...offsets]);
    const columns = {} as SuffixBlock["columns"];
    for (let j = 0; j < 4; j++) {
      columns[`score16-${j + 2}`] = { offset: offsets[j], length: i + j + 1 };
      offsets[j] += i + j + 1;
    }
    builder.append({ columns } as SuffixBlock, 136 + i);
    total += 136 + i;
  }
  const raw = builder.finish(),
    index = new NumericDirectory(raw, corpus, 1050);
  for (let i = 0; i < 150; i++)
    for (let n = 2; n <= 5; n++)
      expect(index.lookup(i, n)).toEqual({
        base: { offset: expected[i][0], length: 136 + i },
        score: { offset: expected[i][n - 1], length: i + n - 1 },
      });
  expect(index.sourceBytes).toBe(total);
  expect(() => new NumericDirectory(raw, "b".repeat(64), 1050)).toThrow(
    "Invalid numeric directory",
  );
  expect(
    () => new NumericDirectory(raw.subarray(0, raw.length - 1), corpus, 1050),
  ).toThrow("Truncated numeric directory");
  expect(() => new NumericDirectoryBuilder(2, corpus, 14).finish()).toThrow(
    "Incomplete",
  );
});

it("finishes small phrases without a remote directory, preserves exhaustive ranking and fields, and starts required columns with the boundary read", async () => {
  const path = await mkdtemp(join(tmpdir(), "suffix-numeric-"));
  try {
    const docs = Array.from({ length: 96 }, (_, doc) => ({
        doc,
        body: Uint32Array.from([
          ...Array(40 + (doc % 9)).fill(1),
          2,
          3,
          doc % 2 ? 4 : 5,
          1,
          2,
          3,
          4,
        ]),
        title: Uint32Array.from(doc % 3 ? [1, 2, 3, 4] : [3, 4, 5]),
      })),
      df = new Uint32Array(6);
    for (const d of docs)
      for (const id of new Set([...d.body, ...d.title])) df[id]++;
    const stats: FixedScores = {
        count: docs.length,
        titleBoost: 2,
        avgBody: docs.reduce((n, d) => n + d.body.length, 0) / docs.length,
        avgTitle: docs.reduce((n, d) => n + d.title.length, 0) / docs.length,
        df,
      },
      manifest = await buildSuffixIndex(
        (async function* () {
          yield* docs;
        })(),
        stats,
        path,
        "a".repeat(64),
        undefined,
        0.02,
      ),
      files = new Map<string, Uint8Array>();
    for (const name of Object.keys(manifest.files))
      files.set(name, await readFile(path + "/" + name));
    const blocks: SuffixBlock[] = manifest.directory.flatMap((g) =>
        JSON.parse(
          gunzipSync(
            files
              .get("directory")!
              .subarray(g.ref.offset, g.ref.offset + g.ref.length),
          ).toString(),
        ),
      ),
      fences = encodeSuffixFences(
        blocks,
        manifest.corpusGeneration,
        manifest.rows,
      ),
      builder = new NumericDirectoryBuilder(
        blocks.length,
        manifest.corpusGeneration,
        manifest.rows,
      ),
      packets = blocks.map((b) => {
        const packet = encodeNumericBase(
          b,
          baseColumns.map((c) =>
            files
              .get(c)!
              .subarray(
                b.columns[c].offset,
                b.columns[c].offset + b.columns[c].length,
              ),
          ),
        );
        builder.append(b, packet.length);
        return packet;
      }),
      numeric = builder.finish(),
      combined = Buffer.concat(packets);
    manifest.numericPackets = { index: "numeric-index", data: "numeric-base" };
    manifest.files["numeric-base"] = {
      bytes: combined.length,
      sha256: "0".repeat(64),
    };
    files.set("numeric-base", combined);
    const calls: string[] = [],
      make = () =>
        new SuffixReader(
          manifest,
          async (file, at, n) => {
            calls.push(file);
            return files.get(file)!.subarray(at, at + n);
          },
          fences,
          { numericIndex: numeric },
        ),
      occurrence = (tokens: Uint32Array, phrase: number[]) =>
        Array.from(tokens, (_, i) => i).some(
          (i) =>
            i + phrase.length <= tokens.length &&
            phrase.every((id, j) => tokens[i + j] === id),
        ),
      matches = (doc: number, phrase: number[], field: string) =>
        (field !== "title" && occurrence(docs[doc].body, phrase)) ||
        (field !== "body" && occurrence(docs[doc].title, phrase)),
      score = (doc: number, words: number[], field: string) =>
        [...new Set(words)].reduce(
          (n, id) =>
            n +
            (field !== "title"
              ? bm25(
                  docs[doc].body.filter((t) => t === id).length,
                  df[id],
                  stats.count,
                  docs[doc].body.length,
                  stats.avgBody,
                )
              : 0) +
            (field !== "body"
              ? 2 *
                bm25(
                  docs[doc].title.filter((t) => t === id).length,
                  df[id],
                  stats.count,
                  docs[doc].title.length,
                  stats.avgTitle,
                )
              : 0),
          0,
        );
    const phrases = [
      [1, 2],
      [2, 3, 4],
      [1, 2, 3, 4],
      [1, 1, 1, 1, 1],
      [3, 4, 5],
      [2, 1],
      [5, 5],
      [5, 1, 2, 3],
    ];
    for (const p of phrases)
      for (const field of ["all", "body", "title"] as const)
        for (const bits of [8, 16] as const) {
          const expected = docs
              .filter((d) => matches(d.doc, p, field))
              .map((d) => ({ doc: d.doc, score: score(d.doc, p, field) }))
              .sort((a, b) => b.score - a.score || a.doc - b.doc),
            reader = make(),
            run = (after?: { doc: number; score: number }) =>
              rankSuffix(
                reader,
                Uint32Array.from(p),
                { bits, field, limit: 7, rangeMax: true, after },
                async (ids) =>
                  Float64Array.from(ids, (doc) => score(doc, p, field)),
              ),
            actual = await run();
          expect(actual.map((h) => h.doc)).toEqual(
            expected.slice(0, 7).map((h) => h.doc),
          );
          if (actual.length) {
            const after = actual.at(-1)!;
            expect((await run(after)).map((h) => h.doc)).toEqual(
              expected
                .filter(
                  (h) =>
                    h.score < after.score ||
                    (h.score === after.score && h.doc > after.doc),
                )
                .slice(0, 7)
                .map((h) => h.doc),
            );
          }
        }
    for (const field of ["all", "body", "title"] as const) {
      const ps = [
          [1, 2],
          [3, 4],
        ],
        expected = docs
          .filter((d) => ps.every((p) => matches(d.doc, p, field)))
          .map((d) => ({ doc: d.doc, score: score(d.doc, ps.flat(), field) }))
          .sort((a, b) => b.score - a.score || a.doc - b.doc),
        result = await rankSuffixConjunction(
          make(),
          ps.map((p) => Uint32Array.from(p)),
          { bits: 16, limit: 7, field, rangeMax: true },
          async (ids) =>
            Float64Array.from(ids, (doc) => score(doc, ps.flat(), field)),
        );
      expect(result!.map((h) => h.doc)).toEqual(
        expected.slice(0, 7).map((h) => h.doc),
      );
    }
    calls.length = 0;
    const direct = make();
    await rankSuffix(
      direct,
      Uint32Array.of(2, 3, 4),
      { bits: 16, limit: 7, rangeMax: true },
      async (ids) =>
        Float64Array.from(ids, (doc) => score(doc, [2, 3, 4], "all")),
    );
    expect(calls).toContain("numeric-base");
    expect(calls).not.toContain("directory");
    expect(calls).not.toContain("flags");
    expect(calls).not.toContain("documents");
    expect(calls).not.toContain("positions");
    expect(new Set(calls.filter((c) => c.startsWith("score")))).toEqual(
      new Set(["score16-3"]),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started: string[] = [],
      parallel = new SuffixReader(
        manifest,
        async (file, at, n) => {
          started.push(file);
          await gate;
          return files.get(file)!.subarray(at, at + n);
        },
        fences,
        { numericIndex: numeric },
      ),
      task = parallel.numericInterval(Uint32Array.of(2, 3, 4), [
        "documents",
        "positions",
        "flags",
        "score16-3",
      ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(new Set(started)).toEqual(
      new Set(["keys", "numeric-base", "score16-3"]),
    );
    release();
    await task;
    expect(() =>
      decodeNumericBase(packets[0].subarray(0, 136), blocks[0]),
    ).toThrow("Truncated");
    expect(() =>
      decodeNumericBase(packets[0], { ...blocks[0], first: 1 }),
    ).toThrow("identity mismatch");
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}, 30000);
