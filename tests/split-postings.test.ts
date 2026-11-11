import { it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFrequencies,
  encodePositions,
  decodeFrequencies,
  attachPositions,
  postingPositions,
  crc32,
} from "../src/format/codec.js";
import { build } from "../src/builder/build.js";
import { BinaryIndex, TERM } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { positionalTerms, parse } from "../src/query/parser.js";
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "split-index-"));
  await writeFile(
    join(root, "docs"),
    [
      { id: "a", body: "red fox dog", title: "café 東京" },
      { id: "b", body: "fox red cat" },
      { id: "c", body: "red red fox dog" },
    ]
      .map((d) => JSON.stringify(d))
      .join("\n"),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
it("encodes frequencies without any position data and attaches independently verified positions", () => {
  const records = [
    { doc: 0, body: 2, title: 1, bodyPositions: [0, 400], titlePositions: [3] },
    {
      doc: 2000,
      body: 1,
      title: 0,
      bodyPositions: [20000],
      titlePositions: [],
    },
  ];
  const f = encodeFrequencies(records),
    p = encodePositions(records),
    d = decodeFrequencies(f, 2, crc32(f));
  expect(d.positionOffsets).toBeUndefined();
  expect(d.bytes.length).toBe(0);
  expect([...d.docs]).toEqual([0, 2000]);
  attachPositions(d, p, crc32(p));
  expect([...postingPositions(d, 0).body]).toEqual([0, 400]);
  expect([...postingPositions(d, 0).title]).toEqual([3]);
  expect([...postingPositions(d, 1).body]).toEqual([20000]);
  const wrong = decodeFrequencies(
    encodeFrequencies([
      { doc: 1, body: 2, title: 1 },
      { doc: 2000, body: 1, title: 0 },
    ]),
  );
  expect(() => attachPositions(wrong, p)).toThrow("stream mismatch");
  expect(() => decodeFrequencies(f, 2, 0)).toThrow("checksum");
  expect(() => attachPositions(decodeFrequencies(f), p, 0)).toThrow("checksum");
  expect(() =>
    attachPositions(decodeFrequencies(f), p.subarray(0, p.length - 1)),
  ).toThrow();
  expect(() => decodeFrequencies(new Uint8Array([1, 0, 0, 0]))).toThrow(
    "Empty",
  );
  const empty = decodeFrequencies(encodeFrequencies([]));
  attachPositions(empty, encodePositions([]));
  expect(empty.docs.length).toBe(0);
});
it("plans positions only for location-dependent operands, including nested negations and filters", () => {
  for (const [q, terms] of [
    ['"red fox" AND dog', ["red", "fox"]],
    ['("red fox" AND NOT dog) /s cat', ["red", "fox", "cat"]],
    ['red AND NOT "blue dog"', ["blue", "dog"]],
    ["(red OR fox) /s (dog AND NOT cat)", ["red", "fox", "dog"]],
    ["red OR NOT dog", []],
  ] as const)
    expect([...positionalTerms(parse(q))].sort()).toEqual([...terms].sort());
});
it("plain Boolean searches never request positions, even when all positional objects are unavailable", async () => {
  const full = await build({
    input: join(root, "docs"),
    out: join(root, "full"),
  });
  const minimum = full.bundleBytes - full.embeddedBytes;
  for (const [name, budget] of [
    ["remote", minimum],
    ["frequency-only", minimum + full.frequencyBytes],
    ["local", 100000],
  ] as const) {
    const out = join(root, name);
    const m = await build({ input: join(root, "docs"), out, budget });
    const i = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
      fs = new FileStorage(join(out, "objects")),
      reads: string[] = [];
    const storage = {
      async read(key: string, offset: number, length: number) {
        reads.push(key);
        if (key.includes("/positions-"))
          throw new Error("Positions must not be read");
        return fs.read(key, offset, length);
      },
    };
    for (const q of [
      "red",
      "red AND (fox OR dog)",
      "red AND NOT cat",
      "NOT cat",
    ]) {
      const r = await search(i, storage, q, { exactTotal: true });
      expect(r.diagnostics.positionRequests).toBe(0);
      expect(r.diagnostics.positionBytes).toBe(0);
      expect(r.total).toBeGreaterThan(0);
    }
    expect(reads.every((k) => k.includes("/frequencies-"))).toBe(true);
    if (name === "frequency-only") {
      expect(m.embeddedFrequencyBytes).toBe(m.frequencyBytes);
      expect(m.embeddedPositionBytes).toBe(0);
      expect(reads).toEqual([]);
      await expect(
        search(i, storage, '"red fox"', { exactTotal: true }),
      ).rejects.toThrow("Positions must not");
    }
    if (name === "local") {
      expect(
        (await search(i, storage, '"red fox"', { exactTotal: true }))
          .diagnostics.fullyLocal,
      ).toBe(true);
    }
  }
});
it("fetches frequency and position streams independently and omits positions for Boolean-only clauses", async () => {
  const full = await build({
    input: join(root, "docs"),
    out: join(root, "read-base"),
  });
  const out = join(root, "read-remote");
  await build({
    input: join(root, "docs"),
    out,
    budget: full.bundleBytes - full.embeddedBytes,
  });
  const index = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
    fs = new FileStorage(join(out, "objects")),
    reads: { key: string; offset: number; length: number }[] = [];
  const storage = {
    async read(key: string, offset: number, length: number) {
      reads.push({ key, offset, length });
      return fs.read(key, offset, length);
    },
  };
  const r = await search(index, storage, '"red fox" AND dog', {
    exactTotal: true,
  });
  expect(r.results.map((x) => x.id).sort()).toEqual(["a", "c"]);
  expect(r.diagnostics.frequencyRequests).toBe(3);
  expect(r.diagnostics.positionRequests).toBe(2);
  expect(r.diagnostics.indexRequests).toBe(5);
  expect(r.diagnostics.indexBytes).toBe(
    r.diagnostics.frequencyBytes + r.diagnostics.positionBytes,
  );
  const expected = ["red", "fox"].map((t) => {
    const e = index.lookup(t)!;
    return {
      key: index.key(e.positionObject, "positions"),
      offset: e.positionOffset,
      length: e.positionLength,
    };
  });
  expect(
    reads
      .filter((r) => r.key.includes("/positions-"))
      .sort((a, b) => a.offset - b.offset),
  ).toEqual(expected.sort((a, b) => a.offset - b.offset));
});
it("corrupt positional descriptors do not affect frequency-only execution", async () => {
  const out = join(root, "descriptor");
  await build({ input: join(root, "docs"), out });
  const bytes = Uint8Array.from(await readFile(join(out, "bundle.bin"))),
    i = new BinaryIndex(bytes);
  let term = 0;
  while (i.entry(term).term !== "red") term++;
  new DataView(bytes.buffer).setUint32(
    i.dict + term * TERM + 32,
    0xffffffff,
    true,
  );
  const corrupt = new BinaryIndex(bytes),
    storage = new FileStorage(join(out, "objects"));
  expect(
    (await search(corrupt, storage, "red", { exactTotal: true })).total,
  ).toBe(3);
  await expect(
    search(corrupt, storage, '"red fox"', { exactTotal: true }),
  ).rejects.toThrow(/memory budget|Invalid local range/);
});
it("also supports local positions paired with remote frequencies", async () => {
  const out = join(root, "reverse-placement");
  await build({ input: join(root, "docs"), out });
  const source = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
    bytes = source.bytes.slice(),
    v = new DataView(bytes.buffer),
    payloads = new Map<string, Uint8Array>();
  for (const [object, term] of ["red", "fox"].entries()) {
    let row = 0;
    while (source.entry(row).term !== term) row++;
    const e = source.entry(row);
    payloads.set(
      source.key(object),
      source.bytes.slice(
        source.local + e.offset,
        source.local + e.offset + e.length,
      ),
    );
    v.setUint32(source.dict + row * TERM + 8, object, true);
    v.setUint32(source.dict + row * TERM + 12, 0, true);
  }
  const storage = {
    async read(key: string, offset: number, length: number) {
      expect(key).toContain("/frequencies-");
      expect(offset).toBe(0);
      const data = payloads.get(key)!;
      expect(data.length).toBe(length);
      return data;
    },
  };
  const result = await search(new BinaryIndex(bytes), storage, '"red fox"', {
    exactTotal: true,
  });
  expect(result.results.map((r) => r.id).sort()).toEqual(["a", "c"]);
  expect(result.diagnostics.frequencyRequests).toBe(2);
  expect(result.diagnostics.positionRequests).toBe(0);
});
