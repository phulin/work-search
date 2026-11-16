import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RangeStorage } from "../bench/columnar/range-storage.js";
import {
  loadRangeSnapshot,
  writePreparedRanges,
} from "../bench/columnar/range-snapshot.js";

it("exports reusable verified ranges while rejecting unread holes and other generations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-snapshot-")),
    key = "a".repeat(64) + "/data.bin",
    bytes = Uint8Array.from({ length: 32 }, (_, i) => i),
    root = {
      generation: "a".repeat(64),
      objects: [{ key, size: 32, sha256: "b".repeat(64) }],
    } as any;
  try {
    const sizes = await writePreparedRanges(
      [
        { key, offset: 0, length: 4 },
        { key, offset: 4, length: 4 },
        { key, offset: 16, length: 8 },
      ],
      join(dir, "local-ranges"),
      async (_, o, n) => bytes.slice(o, o + n),
    );
    expect(sizes).toEqual({ bytes: 16, ranges: 2 });
    const reader = new RangeStorage(root, join(dir, "local-ranges"));
    await reader.verify();
    expect([...(await reader.read(key, 2, 6))]).toEqual([...bytes.slice(2, 8)]);
    await expect(reader.read(key, 6, 12)).rejects.toThrow(
      "Missing prepared range",
    );
    expect(
      await loadRangeSnapshot(dir, root.generation, "corpus"),
    ).toBeUndefined();
    await writeFile(
      join(dir, "range-snapshot.json"),
      JSON.stringify({
        format: "benchmark-ranges-1",
        generation: root.generation,
        corpusHash: "corpus",
        ...sizes,
      }),
    );
    expect(
      (await loadRangeSnapshot(dir, root.generation, "corpus"))!.bytes,
    ).toBe(16);
    await expect(loadRangeSnapshot(dir, "other", "corpus")).rejects.toThrow(
      "generation mismatch",
    );
    await expect(
      loadRangeSnapshot(dir, root.generation, "other"),
    ).rejects.toThrow("generation mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
