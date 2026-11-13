import { it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  TermDirectory,
  assembleTermDirectory,
  encodeDirectoryBlock,
  assembleTieredDirectory,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";
import { encodeTermShard, TermShard } from "../src/columnar/term-shard.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { crc32 } from "../src/format/codec.js";
import { u32 } from "../src/columnar/format.js";
it("routes every bundled term without a remote discovery read, preserving Unicode, counts and exact bounds", async () => {
  const entries: [string, DirectoryTerm][] = Array.from(
    { length: 1500 },
    (_, i) => [
      `${i.toString().padStart(5, "0")}é𐐀`,
      {
        id: i + 1,
        df: i + 1,
        bodyOccurrences: 2 ** 32 + i,
        titleOccurrences: i,
        frequencies: [13, i * 512, 120],
        positional: [14, i * 256, 50],
        tree: {
          first: i,
          last: i * 2,
          count: i + 1,
          height: 0,
          b: 1,
          t: 0.5,
          score: [13, i * 512, 120],
          positions: [14, i * 256, 50],
          locators: [0, 0, 0],
        },
      },
    ],
  );
  const blocks = [];
  for (let at = 0; at < entries.length; at += 128) {
    let e = entries.slice(at, at + 128);
    blocks.push({
      first: e[0][0],
      count: e.length,
      data: gzipSync(encodeDirectoryBlock(e)),
    });
  }
  const bytes = assembleTermDirectory(blocks),
    directory = new TermDirectory(bytes);
  expect(directory.terms).toBe(entries.length);
  for (let at = 0; at < entries.length; at += 17) {
    let wanted = entries.slice(at, at + 17);
    const found = await directory.lookup([
      ...wanted.map(([n]) => n),
      "absent",
      "-before",
    ]);
    expect([...found.keys()].sort()).toEqual(wanted.map(([n]) => n));
    for (const [n, t] of wanted) {
      expect(found.get(n)).toEqual({
        ...t,
        tree: {
          ...t.tree,
          first: 0,
          last: 0xffffffff,
          b: expect.any(Number),
          t: expect.any(Number),
        },
        embedded: undefined,
      });
      expect(found.get(n)!.tree.b).toBeGreaterThanOrEqual(t.tree.b);
    }
  }
  directory.clear();
  expect(
    (await directory.lookup([entries[1400][0]])).get(entries[1400][0]),
  ).toEqual({
    ...entries[1400][1],
    tree: {
      ...entries[1400][1].tree,
      first: 0,
      last: 0xffffffff,
      b: expect.any(Number),
      t: expect.any(Number),
    },
    embedded: undefined,
  });
  const corrupt = bytes.slice();
  new DataView(corrupt.buffer).setUint32(24, bytes.length, true);
  expect(() => new TermDirectory(corrupt)).toThrow();
});
it("keeps hot lookup local and returns rare metadata plus complete packet spans from one cached shard read", async () => {
  const frequency = new Uint8Array(152).map((_, i) => i),
    position = new Uint8Array(40).map((_, i) => 200 + i),
    cold: DirectoryTerm = {
      id: 2,
      df: 1,
      bodyOccurrences: 1,
      titleOccurrences: 0,
      frequencies: [123, 400, frequency.length],
      positional: [124, 800, position.length],
      tree: {
        first: 0,
        last: 9,
        count: 1,
        height: 0,
        b: 100,
        t: 100,
        score: [123, 472, 76],
        positions: [124, 800, position.length],
        locators: [0, 0, 0],
      },
    },
    hot: DirectoryTerm = { ...cold, id: 1 },
    shard = encodeTermShard(gzipSync(encodeDirectoryBlock([["rare", cold]])), [
      { ref: cold.frequencies, data: frequency },
      { ref: cold.positional, data: position },
    ]),
    data = assembleTieredDirectory(
      assembleTermDirectory([
        {
          first: "common",
          count: 1,
          data: gzipSync(encodeDirectoryBlock([["common", hot]])),
        },
      ]),
      assembleTermDirectory([
        { first: "rare", count: 1, data: u32([0, 0, shard.length]) },
      ]),
    ),
    directory = new TermDirectory(data, 10),
    root = {
      generation: "a".repeat(64),
      objects: [
        {
          name: "plan-0.bin",
          size: shard.length,
          sha256: "b".repeat(64),
          checksums: [crc32(shard)],
        },
      ],
    },
    memory = new Memory();
  let gets = 0;
  const source = {
      async read() {
        gets++;
        return shard;
      },
    },
    reader = new Reader(root, source, memory);
  expect(directory.terms).toBe(2);
  expect(directory.bundledTerms).toBe(1);
  expect((await directory.lookup(["common"], reader)).get("common")!.id).toBe(
    1,
  );
  expect(gets).toBe(0);
  const found = await directory.lookup(
    ["rare", "unknown", "!absent", "common"],
    reader,
  );
  expect([...found.keys()].sort()).toEqual(["common", "rare"]);
  expect(gets).toBe(1);
  expect(reader.stats.inlinePostingBytes).toBe(
    frequency.length + position.length,
  );
  expect(await reader.packets([cold.frequencies, cold.positional])).toEqual([
    frequency,
    position,
  ]);
  expect(await reader.read(cold.tree.score)).toEqual(
    frequency.subarray(72, 148),
  );
  expect(gets).toBe(1);
  // A fresh query must re-seed its ranges even when metadata is in the shared
  // application LRU. No physical object descriptors for 123/124 are needed.
  const next = new Reader(root, source, memory);
  await directory.lookup(["rare"], next);
  expect(await next.packets([cold.positional, cold.frequencies])).toEqual([
    position,
    frequency,
  ]);
  expect(gets).toBe(1);
  expect(next.stats.termDirectoryRanges).toBe(0);
  memory.clear();
  directory.clear();
  await directory.lookup(["rare"], new Reader(root, source, memory));
  expect(gets).toBe(2);
  await expect(directory.lookup(["rare"])).rejects.toThrow(
    "requires a query reader",
  );
  const coalesced = new Uint8Array(shard.length + 1048576);
  coalesced.set(shard, 123);
  const retained = await TermShard.decode(
    coalesced.subarray(123, 123 + shard.length),
    10,
  );
  expect(
    retained.inline.every((s) => s.data.buffer.byteLength === shard.length),
  ).toBe(true);
  const bad = shard.slice();
  new DataView(bad.buffer).setUint32(28, bad.length, true);
  await expect(TermShard.decode(bad, 10)).rejects.toThrow(
    "Invalid inline term address",
  );
});
