import { it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  TermDirectory,
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";
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
