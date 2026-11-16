import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RangeStorage } from "../bench/columnar/range-storage.js";

it("serves changed coalescing ranges from verified local coverage without remote I/O", async () => {
  const path = await mkdtemp(join(tmpdir(), "cws-ranges-"));
  try {
    const key = "a".repeat(64) + "/plan-0.bin",
      bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    for (const [offset, length] of [
      [0, 64],
      [32, 96],
      [160, 32],
    ]) {
      const data = bytes.subarray(offset, offset + length),
        file = `${offset}-${length}`;
      await writeFile(path + "/" + file, data);
      await writeFile(
        path + "/" + file + ".json",
        JSON.stringify({
          file,
          key,
          offset,
          bytes: length,
          sha256: createHash("sha256").update(data).digest("hex"),
        }),
      );
    }
    const source = new RangeStorage(
      {
        format: "CWS1",
        count: 1,
        avgBody: 1,
        avgTitle: 1,
        analysis: "nfkc-lower-porter2-v1",
        corpusHash: "c".repeat(64),
        dictionaries: [],
        documents: [],
        hot: {},
        generation: "b".repeat(64),
        objects: [
          { key, name: "plan-0.bin", size: 256, sha256: "a".repeat(64) },
        ],
      },
      path,
    );
    await source.verify();
    expect(await source.read(key, 10, 100)).toEqual(bytes.subarray(10, 110));
    expect(await source.read(key, 64, 32)).toEqual(bytes.subarray(64, 96));
    expect(source.localAssemblies).toBe(2);
    await expect(source.read(key, 100, 80)).rejects.toThrow(
      "Missing prepared range",
    );
    expect(source.reads).toBe(0);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
