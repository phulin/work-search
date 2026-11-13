import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildColumnar } from "../src/columnar/build.js";
import { pack, unpack } from "../src/columnar/format.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { ColumnarIndex } from "../src/columnar/search.js";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { search } from "../src/query/engine.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { reference } from "./reference.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { tokenize } from "../src/query/tokenize.js";
import { buildColumnarPairs } from "../src/columnar/pair-build.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { refAt, view } from "../src/columnar/format.js";
import { gunzipSync } from "node:zlib";
it("preserves JavaScript unpaired UTF-16 strings, metadata keys, normalized passages and split-pair previews", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-surrogates-"));
  try {
    const docs = [
      {
        id: "\ud800",
        title: "Ａ\udfff title",
        body: "Ａlpha\ud800beta 😀 gamma",
        metadata: { ["\ud801"]: "\udfff" },
      },
      { id: "�", title: "other", body: "alpha beta gamma", metadata: null },
      {
        id: "preview",
        title: "",
        body: "x".repeat(399) + "😀tail",
        metadata: { ok: true },
      },
    ];
    const input = dir + "/input";
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const root = await buildColumnar({ input, out: dir + "/index" }),
      objects = new OfflineObjects(dir + "/index", root),
      index = new ColumnarIndex(root);
    try {
      for (const q of [
        "alpha",
        '"alpha beta"',
        "NOT gamma",
        "title",
        "alpha /2 gamma",
      ])
        for (const field of ["all", "body", "title"] as const) {
          const got = await index.search(q, new Reader(root, objects.source), {
            field,
            limit: 20,
          });
          const expected = docs.filter((d) =>
            exhaustive(
              parse(q),
              field === "all"
                ? [tokenize(d.body), tokenize(d.title)]
                : [tokenize(d[field])],
            ),
          );
          expect(got.results.map((r) => r.id).sort()).toEqual(
            expected.map((d) => d.id).sort(),
          );
          for (const hit of got.results) {
            const original = docs.find((d) => d.id === hit.id)!;
            expect(hit.title).toBe(original.title);
            expect(hit.metadata).toEqual(original.metadata);
          }
          if (q === '"alpha beta"' && field !== "title")
            expect(
              got.results.find((r) => r.id === "\ud800")!.snippet,
            ).toContain("Alpha\ud800beta");
        }
      const rows = view(await objects.read(root.documents[0]));
      for (let i = 0; i < docs.length; i++) {
        const record = JSON.parse(
          gunzipSync(await objects.read(refAt(rows, i * 36))).toString(),
        );
        expect(record.preview).toBe(
          docs[i].body.normalize("NFKC").slice(0, 400),
        );
      }
    } finally {
      await objects.close();
    }
    // The same unpaired ID has the same external-sort key in every run.
    await writeFile(
      input,
      docs.map((d) => JSON.stringify(d)).join("\n") +
        "\n" +
        JSON.stringify(docs[0]),
    );
    await expect(
      buildColumnar({ input, out: dir + "/duplicate" }),
    ).rejects.toThrow("Native index builder exited");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
it("round trips full-width, delta, constant and short integer blocks; rejects corruption", () => {
  for (const delta of [false, true])
    for (const a of [
      [],
      [0],
      [0xffffffff],
      [3, 3, 3],
      [0, 127, 128, 65535, 0xffffffff],
      Array.from({ length: 129 }, (_, i) => i * 77777),
    ])
      expect([...unpack(pack(a, delta))]).toEqual(a);
  expect(() => unpack(pack([1, 2, 3]).subarray(0, 12))).toThrow();
});
it("matches exhaustive ranking, AST oracle, field boosts, phrases, complements and search-after across hierarchy boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-"));
  try {
    const docs = Array.from({ length: 8301 }, (_, i) => ({
      id: "d" + i,
      title: i % 3 ? "Alpha Beta" : "Σ İ ℌＥＬＬＯ",
      body:
        i % 29 === 0
          ? "rare alpha beta alpha gamma " + "common ".repeat(i % 40)
          : i % 7 === 0
            ? "beta alpha alpha gamma common"
            : i % 5 === 0
              ? "alpha gamma beta common"
              : "beta common common",
      metadata: { i },
    }));
    docs[17].body = "alpha " + "common ".repeat(10000) + "beta alpha gamma";
    const input = dir + "/corpus.jsonl";
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const root = await buildColumnar({ input, out: dir + "/packed" });
    const index = new ColumnarIndex(root),
      memory = new Memory();
    const source = {
      async read(key: string, offset: number, length: number) {
        return (
          await readFile(dir + "/packed/packs/" + key.split("/").at(-1))
        ).subarray(offset, offset + length);
      },
    };
    await build({ input, out: dir + "/oracle", budget: 8 * 1048576 });
    const oracle = new BinaryIndex(await readFile(dir + "/oracle/bundle.bin")),
      disk = new FileStorage(dir + "/oracle/objects");
    const qs = [
      "alpha",
      "common",
      "rare common",
      "alpha OR beta",
      "NOT rare",
      'NOT "alpha beta"',
      'NOT NOT "alpha beta"',
      'common NOT "alpha beta"',
      '"alpha alpha"',
      '"alpha beta alpha"',
      '"common common common"',
      "alpha /3 beta",
      "(rare OR alpha) /5 gamma",
      "(alpha AND NOT rare) /3 beta",
      "(alpha OR beta) AND common",
      '(alpha /2 beta) NOT ("alpha gamma")',
      "NOT unknown",
      "unknown",
      "constructor",
      "Σ OR hello",
    ];
    for (const q of qs)
      for (const field of ["all", "body", "title"] as const) {
        const options = {
          field,
          titleBoost: field === "title" ? 0 : 3.25,
          limit: 7,
        };
        const got = await index.search(
            q,
            new Reader(root, source, memory),
            options,
          ),
          want = await search(oracle, disk, q, {
            ...options,
            internalDoc: true,
            exactTotal: true,
          });
        expect(
          got.results.map((r) => r.id),
          q + ":" + field,
        ).toEqual(want.results.map((r) => r.id));
        got.results.forEach((r, i) =>
          expect(r.score, q).toBeCloseTo(want.results[i].score, 11),
        );
        if (got.results.length) {
          const last = got.results.at(-1)!;
          const next = await index.search(q, new Reader(root, source, memory), {
            ...options,
            after: { score: last.score, doc: last.doc },
          });
          const refLast = want.results.at(-1)! as any;
          const refNext = await search(oracle, disk, q, {
            ...options,
            after: { score: refLast.score, doc: refLast.doc },
            internalDoc: true,
            exactTotal: true,
          });
          expect(
            next.results.map((r) => r.id),
            q + ":after",
          ).toEqual(refNext.results.map((r) => r.id));
        }
      }
    const independent = reference(docs, "rare gamma", "and", 2);
    const got = await index.search(
      "rare gamma",
      new Reader(root, source, memory),
    );
    expect(got.results.map((r) => r.id)).toEqual(
      independent.slice(0, 20).map((r) => r.id),
    );
    got.results.forEach((r, i) =>
      expect(r.score).toBeCloseTo(independent[i].score, 11),
    );
    expect(got.results.every((r) => r.snippet?.includes("rare"))).toBe(true);
    // Rebuild determinism includes immutable object checksums and root routing.
    const again = await buildColumnar({ input, out: dir + "/again" });
    expect(again).toEqual(root);
    const corrupt = {
      async read(key: string, offset: number, length: number) {
        const b = Uint8Array.from(await source.read(key, offset, length));
        b[0] ^= 1;
        return b;
      },
    };
    await expect(
      new Reader(root, corrupt).read(root.documents[0]),
    ).rejects.toThrow("checksum");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
it("uses corpus-selected positional pairs and forward IDs without false absence or cross-field matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-pairs-"));
  try {
    const docs = Array.from({ length: 1000 }, (_, i) => ({
      id: "d" + i,
      title: i === 7 ? "alpha beta gamma" : "Court",
      body: i < 5 ? "alpha beta gamma" : "alpha red beta red gamma",
    }));
    docs[8].body = "alpha beta x beta gamma";
    docs[9].body = "alpha beta";
    docs[9].title = "gamma";
    docs[10].body = "alpha gamma beta alpha beta gamma";
    docs[11].body = "alpha ".repeat(10000) + "beta gamma";
    docs[12].body = "Ａlpha beta gamma";
    const input = dir + "/input";
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const root = await buildColumnar({ input, out: dir + "/base" }),
      pairs = await buildColumnarPairs(dir + "/base", 1048576, 32),
      index = new ColumnarIndex(root),
      files = await Promise.all(
        root.objects.map((o) => readFile(dir + "/base/packs/" + o.name)),
      ),
      pairFiles = await Promise.all(
        pairs.objects.map((o) => readFile(dir + "/base/pairs/packs/" + o.name)),
      );
    expect(pairs.coverage.pairs).toBeGreaterThan(0);
    const source = {
        async read(key: string, offset: number, length: number) {
          return files[Number(key.match(/plan-(\d+)/)![1])].subarray(
            offset,
            offset + length,
          );
        },
      },
      pairSource = {
        async read(key: string, offset: number, length: number) {
          return pairFiles[Number(key.match(/plan-(\d+)/)![1])].subarray(
            offset,
            offset + length,
          );
        },
      };
    for (const q of [
      '"alpha beta gamma"',
      '"alpha beta beta gamma"',
      '"alpha alpha beta"',
      'NOT "alpha beta gamma"',
      "alpha NOT (beta /2 gamma)",
      '"beta gamma" /4 red',
      "(alpha OR red) /3 beta",
      "(NOT gamma AND beta) /3 alpha",
      '"alpha beta" OR red',
      '(NOT "alpha alpha") AND gamma',
    ]) {
      const ast = parse(q),
        ts = queryTerms(ast, true),
        ranked = ts.length
          ? reference(docs, ts.join(" "), "or")
          : docs.map((d) => ({ id: d.id, score: 0 })),
        matched = new Set(
          docs
            .filter((d) =>
              exhaustive(ast, [tokenize(d.body), tokenize(d.title)]),
            )
            .map((d) => d.id),
        ),
        want = ranked.filter((r) => matched.has(r.id)).slice(0, 20),
        memory = new Memory();
      const got = await index.search(
        q,
        new Reader(root, source, memory),
        {},
        { root: pairs, reader: new Reader(pairs, pairSource, memory) },
      );
      expect(
        got.results.map((r) => r.id),
        q,
      ).toEqual(want.map((r) => r.id));
      got.results.forEach((r, i) =>
        expect(r.score, q).toBeCloseTo(want[i].score, 11),
      );
      if (q === '"alpha beta gamma"') {
        expect(got.diagnostics.pair?.used).toBe(true);
        expect(got.diagnostics.positionIntegers).toBeGreaterThan(0);
        expect(got.results.some((r) => r.id === "d9")).toBe(false);
      }
    }
    const missing = { ...pairs, dictionaries: [], hot: {} };
    const a = await index.search(
        '"alpha beta gamma"',
        new Reader(root, source),
        {},
        { root: missing, reader: new Reader(missing, pairSource) },
      ),
      b = await index.search('"alpha beta gamma"', new Reader(root, source));
    expect(a.results).toEqual(b.results);
    await expect(
      index.search(
        "alpha",
        new Reader(root, source),
        {},
        {
          root: { ...pairs, baseGeneration: "f".repeat(64) },
          reader: new Reader(pairs, pairSource),
        },
      ),
    ).rejects.toThrow("generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
