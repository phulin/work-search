import { it, expect } from "vitest";
import {
  DocumentPackage,
  encodeDocumentPackage,
} from "../src/columnar/document-package.js";
import { tokenize } from "../src/query/tokenize.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { crc32 } from "../src/format/codec.js";
it("renders the same relevant passage by scanning packed tokens without expanding the document", async () => {
  for (const width of [0, 1, 7, 13, 24, 32]) {
    const id = width ? 2 ** width - 1 : 0,
      ids = new Map([
        ["filler", 0],
        ["needle", id],
      ]);
    for (const at of [0, 31, 32, 255, 256, 257, 600]) {
      const words = Array.from({ length: 650 }, (_, p) =>
          p === at ? "needle" : "filler",
        ),
        data = await encodeDocumentPackage(
          { doc: 0, id: "packed", body: words.join(" ") },
          ids,
        ),
        observations: { kind: string; section: number; n: number }[] = [],
        scanned = new DocumentPackage(data, 0, (kind, section, n) =>
          observations.push({ kind, section, n }),
        ),
        expanded = new DocumentPackage(data, 0),
        wanted = new Set([id]),
        tokens = expanded.tokens(0),
        first = tokens.findIndex((n) => wanted.has(n));
      expect(await scanned.snippet(wanted)).toBe(
        await expanded.snippet(wanted, first),
      );
      expect(observations.filter((o) => o.kind === "tokens")).toEqual([
        { kind: "tokens", section: 1, n: first + 1 },
      ]);
      expect(observations.filter((o) => o.kind === "decoded")).toEqual([]);
      expect(await scanned.snippet(new Set([id + 1]))).toBe(
        await expanded.snippet(new Set([id + 1])),
      );
      expect(await scanned.snippet(new Set())).toBe(
        await expanded.snippet(new Set()),
      );
    }
  }
});
it("finishes a document from one independently sectioned package, preserving exact statistics, Unicode and relevant snippets", async () => {
  const doc = {
      doc: 123,
      id: "id\ud800",
      title: "İ Alpha title",
      metadata: { x: "\udfff" },
      body:
        "A ".repeat(800) +
        "Ａlpha beta needle\ud800end " +
        "later ".repeat(350),
    },
    body = tokenize(doc.body),
    title = tokenize(doc.title),
    ids = new Map(
      [...new Set([...body, ...title])].sort().map((w, i) => [w, i + 1]),
    ),
    data = await encodeDocumentPackage(doc, ids),
    pkg = new DocumentPackage(data, doc.doc),
    f = pkg.frequencies();
  expect(pkg.bodyLength).toBe(body.length);
  expect(pkg.titleLength).toBe(title.length);
  expect([...pkg.tokens(0)]).toEqual(body.map((w) => ids.get(w)));
  expect([...pkg.tokens(1)]).toEqual(title.map((w) => ids.get(w)));
  for (let i = 0; i < f.ids.length; i++) {
    const word = [...ids].find(([, id]) => id === f.ids[i])![0];
    expect(f.body[i]).toBe(body.filter((w) => w === word).length);
    expect(f.title[i]).toBe(title.filter((w) => w === word).length);
  }
  const wanted = new Set([ids.get("alpha")!, ids.get("needle")!]);
  for (const field of [0, 1]) {
    const p = pkg.positions(wanted, field),
      tokens = field ? title : body;
    for (const id of wanted)
      expect(p.get(id) ?? []).toEqual(
        tokens.flatMap((word, i) => (ids.get(word) === id ? [i] : [])),
      );
  }
  expect(await pkg.display()).toEqual({
    id: doc.id,
    title: doc.title,
    metadata: doc.metadata,
  });
  expect(await pkg.snippet(new Set([ids.get("needle")!]))).toContain(
    "needle\ud800end",
  );
  expect(await pkg.snippet(wanted, 800)).toContain("Alpha beta");
  expect(await pkg.snippet(wanted, undefined, true)).toBe(doc.title);
  expect(() => new DocumentPackage(data, 124)).toThrow("Invalid document");
  const bad = data.slice();
  new DataView(bad.buffer).setUint32(16, 65, true);
  expect(() => new DocumentPackage(bad, 123)).toThrow("section");
  const empty = new DocumentPackage(
    await encodeDocumentPackage({ doc: 0, id: "empty", body: "" }, new Map()),
    0,
  );
  expect(await empty.snippet(new Set())).toBe("");
  expect(empty.frequencies().ids.length).toBe(0);
});
it("reuses validated large result packages from shared cache after clearing application memory", async () => {
  const random = new Uint8Array(3 * 1048576);
  let seed = 79;
  for (let i = 0; i < random.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    random[i] = seed & 255;
  }
  const metadata = { payload: Buffer.from(random).toString("base64") },
    data = await encodeDocumentPackage(
      { doc: 7, id: "large", body: "alpha beta", metadata },
      new Map([
        ["alpha", 1],
        ["beta", 2],
      ]),
    ),
    generation = "a".repeat(64),
    memory = new Memory(),
    cache = new Map<string, Uint8Array>(),
    pending: Promise<unknown>[] = [];
  expect(data.length).toBeGreaterThan(2 * 1048576);
  let reads = 0;
  const source = {
      async read() {
        throw Error("Unexpected discovery read");
      },
      async readWhole() {
        reads++;
        return { data, checksum: crc32(data) };
      },
    },
    shared = {
      async get(key: string) {
        return cache.get(key);
      },
      async put(key: string, bytes: Uint8Array) {
        cache.set(key, bytes);
      },
    },
    first = new Reader(
      { generation, objects: [] },
      source,
      memory,
      shared,
      "test",
      (p) => pending.push(p),
    );
  expect(
    (await (await first.document(generation, 7)).display()).metadata,
  ).toEqual(metadata);
  await Promise.all(pending);
  memory.clear();
  const repeated = new Reader(
    { generation, objects: [] },
    source,
    memory,
    shared,
    "test",
  );
  expect(
    await (await repeated.document(generation, 7)).snippet(new Set([2])),
  ).toContain("beta");
  expect(repeated.stats.requests).toBe(0);
  expect(repeated.stats.sharedGets).toBe(1);
  expect(reads).toBe(1);
});
