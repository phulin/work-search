import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetadata } from "../scripts/build-columnar-metadata.js";
import {
  MetadataIndex,
  compileMetadataPredicate,
  encodeMetadataColumn,
} from "../src/columnar/metadata-filter.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { filterDocuments } from "../src/columnar/document-filter.js";

it("filters bounded typed metadata columns with explicit missing values and generation identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-metadata-"));
  try {
    const root = { generation: "a".repeat(64), count: 5, objects: [] },
      schema = {
        court: "string",
        date: "number",
        published: "boolean",
      } as const;
    const metadata = [
      { court: "é", date: 20200101, published: false },
      { court: "scotus", date: 20210101, published: true },
      { court: "ca1", date: 20190101, published: false },
      { court: "scotus", date: 20230101, published: true },
      { court: "", date: null, published: null },
    ];
    async function* records() {
      for (let doc = 0; doc < metadata.length; doc++)
        yield { doc, metadata: metadata[doc] };
    }
    const manifest = await buildMetadata(root, schema, records(), dir, 2),
      index = new MetadataIndex(manifest, root),
      keys: string[] = [];
    const source = {
      read: async () => {
        throw Error("No posting I/O");
      },
      readNamed: async (key: string) => {
        keys.push(key);
        return readFile(dir + "/objects/" + key.split("/")[0] + ".bin");
      },
    };
    const memory = new Memory(),
      reader = new Reader(root, source, memory);
    const predicate = {
      and: [
        { field: "court", op: "in", value: ["scotus", "ca1"] },
        {
          or: [
            { field: "date", op: "gte", value: 20200101 },
            { field: "published", op: "eq", value: false },
          ],
        },
      ],
    };
    expect([
      ...(await filterDocuments(
        Uint32Array.of(0, 1, 2, 3, 4),
        index.filter(predicate, reader),
        reader.stats,
      )),
    ]).toEqual([1, 2, 3]);
    expect(reader.stats.metadataFilterRejected).toBe(2);
    const snapshot = keys.length;
    expect([
      ...(await filterDocuments(
        Uint32Array.of(1, 3),
        index.filter({ field: "court", op: "eq", value: "scotus" }, reader),
        reader.stats,
      )),
    ]).toEqual([1, 3]);
    expect(keys.length).toBe(snapshot); // shares bounded raw metadata cache
    const none = index.filter({ not: { field: "date", op: "exists" } }, reader);
    expect([
      ...(await filterDocuments(
        Uint32Array.of(0, 1, 2, 3, 4),
        none,
        reader.stats,
      )),
    ]).toEqual([4]);
    expect(() =>
      index.filter({ field: "missing", op: "eq", value: 1 }, reader),
    ).toThrow("Invalid metadata filter");
    expect(keys.length).toBe(snapshot);
    expect(
      () =>
        new MetadataIndex(manifest, { ...root, generation: "b".repeat(64) }),
    ).toThrow("generation");
    expect(
      () =>
        new MetadataIndex(
          { ...manifest, blocks: manifest.blocks.slice(1) },
          root,
        ),
    ).toThrow();
    // A prepared predicate owns its batch, so a concurrent batch cannot change it.
    const f = index.filter(
      { field: "date", op: "gt", value: 20200101 },
      reader,
    );
    const [a, b] = await Promise.all([
      f.prepare(Uint32Array.of(1)),
      f.prepare(Uint32Array.of(2, 3)),
    ]);
    expect(a(1)).toBe(true);
    expect(b(2)).toBe(false);
    expect(b(3)).toBe(true);
    expect(a(4)).toBe(false);
    await expect(
      buildMetadata(
        root,
        schema,
        (async function* () {
          yield { doc: 1, metadata: {} };
        })(),
        dir + "/bad",
        2,
      ),
    ).rejects.toThrow("exactly once");
    await expect(
      buildMetadata(
        root,
        schema,
        (async function* () {
          yield { doc: 0, metadata: {} };
        })(),
        dir + "/short",
        2,
      ),
    ).rejects.toThrow("Incomplete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("validates filter types, nesting, Boolean logic and exact scalar semantics before I/O", () => {
  const schema = { s: "string", n: "number", b: "boolean" } as const;
  const test = (p: unknown, record: Record<string, any>) =>
    compileMetadataPredicate(p, schema).test((f) => record[f]);
  expect(test({ field: "s", op: "ne", value: "x" }, {})).toBe(false);
  expect(test({ not: { field: "s", op: "eq", value: "x" } }, {})).toBe(true);
  expect(test({ field: "s", op: "eq", value: "É" }, { s: "é" })).toBe(false);
  expect(test({ field: "s", op: "eq", value: "" }, { s: "" })).toBe(true);
  expect(test({ field: "b", op: "eq", value: false }, { b: false })).toBe(true);
  expect(test({ field: "n", op: "lte", value: 0 }, { n: -1 })).toBe(true);
  expect(test({ and: [] }, {})).toBe(true);
  expect(test({ or: [] }, {})).toBe(false);
  for (const p of [
    { field: "n", op: "eq", value: "1" },
    { field: "n", op: "gte", value: Infinity },
    { field: "b", op: "lt", value: true },
    { field: "s", op: "in", value: [1] },
    { field: "__proto__", op: "exists" },
    { not: [], extra: 1 },
    { field: "s", op: "exists", value: 1 },
  ])
    expect(() => compileMetadataPredicate(p, schema)).toThrow();
  let deep: any = { field: "s", op: "exists" };
  for (let i = 0; i < 20; i++) deep = { not: deep };
  expect(() => compileMetadataPredicate(deep, schema)).toThrow();
  expect(() => encodeMetadataColumn(0, "number", [Infinity])).toThrow();
  expect(() => encodeMetadataColumn(0, "boolean", ["false"])).toThrow();
});

it("extracts existing package metadata in internal-ID order and refuses a stale directory or damaged group", async () => {
  const { createHash } = await import("node:crypto"),
    { writeFile, mkdir } = await import("node:fs/promises"),
    { encodeDocumentPackage } =
      await import("../src/columnar/document-package.js"),
    { encodeDocumentDirectory, pack } =
      await import("../src/columnar/document-directory.js"),
    { concat } = await import("../src/columnar/format.js"),
    { packageMetadata } =
      await import("../scripts/columnar-metadata-source.js");
  const dir = await mkdtemp(join(tmpdir(), "cws-metadata-source-"));
  try {
    const ids = new Map([
        ["alpha", 1],
        ["beta", 2],
      ]),
      first = await encodeDocumentPackage(
        { doc: 0, id: "z", body: "alpha beta", metadata: { value: "first" } },
        ids,
      ),
      second = await encodeDocumentPackage(
        { doc: 1, id: "a", body: "beta", metadata: { value: "second" } },
        ids,
      ),
      group = concat([first, second]),
      hash = createHash("sha256").update(group).digest("hex"),
      key = hash + "/plan-0.bin";
    const data = encodeDocumentDirectory(
      [
        {
          first: 0,
          end: 2,
          sha256: hash,
          offsets: pack([0, first.length, group.length], true),
        },
      ],
      2,
    );
    await writeFile(dir + "/documents.bin", data);
    await writeFile(
      dir + "/root.json",
      JSON.stringify({
        count: 2,
        documentPackages: {
          locators: {
            bytes: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
        },
      }),
    );
    await mkdir(dir + "/mirror/objects/" + hash, { recursive: true });
    await writeFile(dir + "/mirror/objects/" + key, group);
    const collect = async () => {
      const rows = [];
      for await (const row of packageMetadata(dir, dir + "/mirror"))
        rows.push(row);
      return rows;
    };
    expect(await collect()).toEqual([
      { doc: 0, metadata: { value: "first" } },
      { doc: 1, metadata: { value: "second" } },
    ]);
    await writeFile(dir + "/documents.bin", data.subarray(0, data.length - 1));
    await expect(collect()).rejects.toThrow("directory identity");
    await writeFile(dir + "/documents.bin", data);
    const broken = group.slice();
    broken[broken.length - 1] ^= 1;
    await writeFile(dir + "/mirror/objects/" + key, broken);
    await expect(collect()).rejects.toThrow("package identity");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
