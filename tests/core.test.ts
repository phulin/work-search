import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenize } from "../src/query/tokenize.js";
import {
  varint,
  readVarint,
  encodePostings,
  decodePostings,
  crc32,
} from "../src/format/codec.js";
import { BinaryIndex, LOCAL } from "../src/format/index.js";
import { build } from "../src/builder/build.js";
import { selectPostings } from "../src/builder/selection.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { R2Storage } from "../src/storage/r2.js";
import { search, intersect, union, bm25 } from "../src/query/engine.js";
import { handler } from "../src/worker/handler.js";
import { reference } from "./reference.js";
let root: string;
const docs = [
  { id: "a", title: "Red fox", body: "red red fox café", metadata: { n: 1 } },
  { id: "b", title: "Blue", body: "blue fox 東京" },
  { id: "c", body: "red dog" },
  { id: "d", body: "" },
];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "search-test-"));
  await writeFile(
    join(root, "input"),
    docs.map((d) => JSON.stringify(d)).join("\n"),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture(
  name: string,
  budget = 100000,
  strategy: "smallest" | "workload" = "smallest",
) {
  const out = join(root, name);
  const m = await build({
    input: join(root, "input"),
    out,
    budget,
    strategy,
    workload: ["red fox"],
    chunkDocs: 1,
    objectBytes: 20,
  });
  return {
    out,
    m,
    index: new BinaryIndex(await readFile(join(out, "bundle.bin"))),
    store: new FileStorage(join(out, "objects")),
  };
}
describe("binary primitives", () => {
  it("normalizes Unicode", () =>
    expect(tokenize("CAFÉ café ＦＯＸ 東京 ١٢")).toEqual([
      "café",
      "café",
      "fox",
      "東京",
      "١٢",
    ]));
  it("round trips varints and rejects truncation", () => {
    for (const n of [0, 127, 128, 16384, 0xffffffff]) {
      const b: number[] = [];
      varint(b, n);
      expect(readVarint(Uint8Array.from(b), { i: 0 })).toBe(n);
    }
    expect(() => readVarint(new Uint8Array([128]), { i: 0 })).toThrow();
    expect(() =>
      readVarint(new Uint8Array([255, 255, 255, 255, 127]), { i: 0 }),
    ).toThrow();
  });
  it("round trips posting lists", () => {
    const p = [
      { doc: 0, body: 1, title: 0 },
      { doc: 132, body: 5, title: 2 },
    ];
    const d = decodePostings(encodePostings(p));
    expect([...d.docs]).toEqual([0, 132]);
    expect([...d.title]).toEqual([0, 2]);
    expect(() => decodePostings(new Uint8Array([99]))).toThrow();
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("combines sorted lists", () => {
    const a = new Uint32Array([1, 3, 7]),
      b = new Uint32Array([2, 3]);
    expect([...intersect(a, b)]).toEqual([3]);
    expect([...union(a, b)]).toEqual([1, 2, 3, 7]);
  });
  it("computes BM25", () => {
    expect(bm25(1, 1, 3, 4, 4)).toBeCloseTo(Math.log(1 + 2.5 / 1.5));
    expect(bm25(0, 1, 3, 0, 0)).toBe(0);
  });
  it("selects packages using whole-query utility", () => {
    const items = [
      { term: "a", length: 4 },
      { term: "b", length: 4 },
      { term: "c", length: 3 },
    ];
    expect([...selectPostings(items, 8, "smallest")]).toEqual(["c", "a"]);
    expect(
      [...selectPostings(items, 8, "workload", ["a b", "a b"])].sort(),
    ).toEqual(["a", "b"]);
  });
});
describe("engine and builder", () => {
  it("has dictionary lookup, missing and empty semantics", async () => {
    const { index, store } = await fixture("dictionary");
    expect(index.lookup("fox")?.df).toBe(2);
    expect(index.lookup("café")?.df).toBe(1);
    expect(index.lookup("missing")).toBeUndefined();
    expect((await search(index, store, "fox unknown")).total).toBe(0);
    expect((await search(index, store, "")).results).toEqual([]);
    expect(
      (await search(index, store, "fox unknown", { mode: "or" })).total,
    ).toBe(2);
  });
  it("matches independent reference across all embedding budgets and modes", async () => {
    const full = await fixture("full");
    const base = full.m.bundleBytes - full.m.embeddedBytes;
    for (const [name, budget] of [
      ["remote", base],
      ["mixed", base + 10],
      ["local", 100000],
    ] as const) {
      const { index, store } = await fixture(name, budget);
      for (const mode of ["and", "or"] as const)
        for (const q of [
          "red fox",
          "blue",
          "red dog",
          "東京 café",
          "unknown",
          "red red",
          "",
        ]) {
          const got = await search(index, store, q, { mode, limit: 100 }),
            expected = reference(docs, q, mode);
          expect(got.results.map((r) => r.id)).toEqual(
            expected.map((r) => r.id),
          );
          got.results.forEach((r, i) =>
            expect(r.score).toBeCloseTo(expected[i].score, 12),
          );
        }
      const r = await search(index, store, "fox");
      expect(r.diagnostics.indexRequests).toBe(
        name === "local"
          ? 0
          : name === "remote"
            ? 1
            : r.diagnostics.indexRequests,
      );
      if (name === "mixed") {
        expect(
          [...Array(index.termCount)]
            .map((_, i) => index.entry(i).object)
            .some((o) => o === LOCAL),
        ).toBe(true);
        expect(
          [...Array(index.termCount)]
            .map((_, i) => index.entry(i).object)
            .some((o) => o !== LOCAL),
        ).toBe(true);
      }
    }
  });
  it("fetches metadata separately and supports title/body fields", async () => {
    const { index, store } = await fixture("metadata");
    expect((await search(index, store, "red")).diagnostics.fullyLocal).toBe(
      true,
    );
    const r = await search(index, store, "red", { metadata: true });
    expect(r.results[0].metadata).toEqual({ n: 1 });
    expect(r.diagnostics.metadataRequests).toBe(2);
    expect(r.diagnostics.indexRequests).toBe(0);
    expect((await search(index, store, "red", { field: "title" })).total).toBe(
      1,
    );
    expect(
      (await search(index, store, "dog", { field: "body" })).results[0].id,
    ).toBe("c");
  });
  it("builds deterministically across spill sizes", async () => {
    const a = await fixture("det-a");
    const out = join(root, "det-b");
    await build({
      input: join(root, "input"),
      out,
      budget: 100000,
      workload: ["red fox"],
      chunkDocs: 10,
      objectBytes: 20,
    });
    expect(await readFile(join(a.out, "bundle.bin"))).toEqual(
      await readFile(join(out, "bundle.bin")),
    );
    expect(await readFile(join(a.out, "manifest.json"))).toEqual(
      await readFile(join(out, "manifest.json")),
    );
  });
  it("rejects corruption/version mismatch and wrong R2 generations", async () => {
    const { index, store } = await fixture("bad");
    const bytes = index.bytes.slice();
    bytes[4] = 99;
    expect(() => new BinaryIndex(bytes)).toThrow();
    bytes[4] = 1;
    const e = index.lookup("red")!;
    bytes[index.local + e.offset] ^= 1;
    await expect(search(new BinaryIndex(bytes), store, "red")).rejects.toThrow(
      "checksum",
    );
    const r2 = new R2Storage(
      {
        get: async () => ({
          customMetadata: { generation: "wrong" },
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      } as unknown as R2Bucket,
      index.generation,
    );
    await expect(r2.read(index.key(0), 0, 1)).rejects.toThrow("generation");
  });
  it("accepts empty and rejects malformed and duplicate documents", async () => {
    for (const [name, text, error] of [
      ["empty", "", false],
      ["malformed", "{", true],
      ["invalid", '{"id":"a"}', true],
      ["duplicate", '{"id":"x","body":"a"}\n{"id":"x","body":"b"}', true],
    ] as const) {
      const input = join(root, name + ".jsonl");
      await writeFile(input, text);
      const p = build({ input, out: join(root, "input-" + name) });
      if (error) await expect(p).rejects.toThrow();
      else {
        const m = await p;
        expect(m.documents).toBe(0);
      }
    }
  });
  it("validates HTTP and gates diagnostics", async () => {
    const { index, store } = await fixture("http");
    const h = handler(index, store);
    expect((await h(new Request("https://x/search?limit=0"))).status).toBe(400);
    expect((await h(new Request("https://x/health"))).status).toBe(200);
    const r = (await (
      await h(new Request("https://x/search?q=red&diagnostics=true"))
    ).json()) as any;
    expect(r.diagnostics).toBeUndefined();
  });
});
