import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { search as reference } from "../bench/baseline-next.js";
it("block iterators preserve exhaustive scores, field matching, Boolean trees, boosts and ties", async () => {
  const root = await mkdtemp(join(tmpdir(), "next-"));
  try {
    const input = join(root, "input");
    await writeFile(
      input,
      Array.from({ length: 2401 }, (_, i) =>
        JSON.stringify({
          id: `d${i}`,
          body:
            "common ".repeat((i % 7) + 1) +
            (i % 11 ? "blue " : "red ") +
            (i % 13 ? "fox" : "cat"),
          title: i % 3 ? "common blue" : "red cat",
        }),
      ).join("\n"),
    );
    for (const budget of [20000, 1000000]) {
      const out = join(root, String(budget));
      await build({ input, out, budget });
      const index = new BinaryIndex(await readFile(out + "/bundle.bin")),
        store = new FileStorage(out + "/objects");
      expect(index.bytes.length).toBeLessThanOrEqual(budget);
      for (const q of [
        "common",
        "common blue",
        "common OR red",
        "(red AND cat) OR blue",
        '"common common"',
        "common /3 fox",
        "common AND NOT cat",
        "NOT blue",
      ])
        for (const field of ["all", "body", "title"] as const)
          for (const titleBoost of [0, 2, 20]) {
            const a = await search(index, store, q, {
              field,
              titleBoost,
              limit: 7,
            });
            const b = await reference(index, store, q, {
              field,
              titleBoost,
              limit: 7,
              exactTotal: true,
            });
            expect(a.results, `${q}/${field}/${titleBoost}`).toEqual(b.results);
            expect(a).not.toHaveProperty("total");
          }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

import { encodePacked, decodePacked } from "../src/format/packed.js";
import { encodeBlocks } from "../src/format/blocks.js";
import { loadPosting } from "../src/query/load.js";
import { crc32, postingPositions, type Posting } from "../src/format/codec.js";
it("packed columns round trip constants, sparse gaps, all widths and large integers", () => {
  for (let width = 1; width <= 32; width++) {
    const rows = Array.from({ length: 256 }, (_, i) => ({
      doc: i * 3,
      body: i % 2 ? 2 ** width - 1 : 1,
      title: i % 3,
    }));
    const bytes = encodePacked(rows),
      result = {
        docs: new Uint32Array(256),
        body: new Uint32Array(256),
        title: new Uint32Array(256),
        bytes: new Uint8Array(0),
      };
    expect(decodePacked(bytes, result, 0, 256)).toBe(true);
    expect([...result.docs]).toEqual(rows.map((r) => r.doc));
    expect([...result.body]).toEqual(rows.map((r) => r.body));
    expect([...result.title]).toEqual(rows.map((r) => r.title));
    expect(() =>
      decodePacked(bytes.subarray(0, bytes.length - 1), result, 0, 256),
    ).toThrow();
  }
});
it("dense positional blocks seek rows at restart and partial-block boundaries", async () => {
  const rows: Posting[] = Array.from({ length: 777 }, (_, i) => ({
    doc: i * 7,
    body: 12,
    title: 2,
    bodyPositions: Array.from({ length: 12 }, (_, j) => j * 128 + i),
    titlePositions: [1, 300],
  }));
  const b = encodeBlocks(rows, {
    packed: true,
    seekPositions: true,
    count: 6000,
    avgBody: 12,
    avgTitle: 2,
    lengths: () => ({ body: 12, title: 2 }),
  });
  const e = {
    format: 8,
    term: "dense",
    df: rows.length,
    object: 0,
    offset: 0,
    length: b.frequencies.length,
    crc: b.crc,
    positionObject: 0,
    positionOffset: 0,
    positionLength: b.positions.length,
    positionCrc: crc32(b.positions),
  };
  for (const candidates of [undefined, new Uint32Array([0, 1792, 5432])]) {
    const decoded = await loadPosting(
      e,
      true,
      async (_, p, offset, length) =>
        (p ? b.positions : b.frequencies).subarray(offset, offset + length),
      candidates,
    );
    expect(decoded.positionEnds).toBeDefined();
    for (let row = 0; row < decoded.docs.length; row++) {
      const original = rows[decoded.docs[row] / 7];
      expect([...postingPositions(decoded, row).body]).toEqual(
        original.bodyPositions,
      );
      expect([...postingPositions(decoded, row).title]).toEqual(
        original.titlePositions,
      );
    }
  }
});
