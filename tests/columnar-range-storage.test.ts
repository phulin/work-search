import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RangeStorage } from "../bench/columnar/range-storage.js";

it("prepares immutable ranges once, replays without network or checksumming, and rejects damaged preparation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "columnar-ranges-")),
    key = "a".repeat(64) + "/plan-0.bin",
    data = Uint8Array.of(7, 8, 9),
    root = {
      generation: "a".repeat(64),
      objects: [{ key, sha256: "b".repeat(64), size: 100 }],
    } as any,
    fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(data, {
          headers: {
            "x-sha256": "b".repeat(64),
            "x-generation": "a".repeat(64),
          },
        }),
    );
  try {
    const source = new RangeStorage(root, directory, {
      url: "https://example.invalid",
      token: "test",
    });
    source.prepare = true;
    expect([...(await source.read(key, 10, 3))]).toEqual([...data]);
    const replay = new RangeStorage(root, directory);
    await replay.verify();
    fetch.mockRejectedValue(Error("Network forbidden in replay"));
    expect([...(await replay.read(key, 10, 3))]).toEqual([...data]);
    await expect(replay.read(key, 30, 3)).rejects.toThrow(
      "Missing prepared range",
    );
    const file = createHash("sha256")
      .update(key + ":10:3")
      .digest("hex");
    await writeFile(directory + "/" + file, Uint8Array.of(7, 8, 0));
    await expect(new RangeStorage(root, directory).verify()).rejects.toThrow(
      "Corrupt",
    );
  } finally {
    fetch.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    // A concurrent preparation can create the exact requested filename after
    // verification. Ignore its unverified bytes and use verified coverage.
    const unverified = createHash("sha256")
      .update(key + ":10:100")
      .digest("hex");
    await writeFile(path + "/" + unverified, Buffer.alloc(100, 255));
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

it("prepares every small object, including unvisited objects, so speculative reads remain offline", async () => {
  const path = await mkdtemp(join(tmpdir(), "cws-complete-ranges-")),
    key = "a".repeat(64) + "/plan-0.bin",
    other = "c".repeat(64) + "/plan-0.bin",
    data = Buffer.from(Array.from({ length: 64 }, (_, i) => i)),
    sha = createHash("sha256").update(data).digest("hex"),
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, options) => {
        const headers = new Headers(options?.headers),
          offset = Number(headers.get("x-offset")),
          length = Number(headers.get("x-length"));
        return new Response(data.subarray(offset, offset + length), {
          headers: {
            "x-generation": String(url).includes(other)
              ? "c".repeat(64)
              : "a".repeat(64),
            "x-sha256": sha,
          },
        });
      });
  try {
    const source = new RangeStorage(
      {
        generation: "a".repeat(64),
        objects: [{ key, size: 64, sha256: sha }],
      } as any,
      path,
      { url: "https://example.invalid", token: "test" },
    );
    source.include([{ key: other, size: 64, sha256: sha }]);
    source.prepare = true;
    expect(await source.read(key, 10, 3)).toEqual(data.subarray(10, 13));
    expect(await source.completePreparation()).toEqual({
      objects: 2,
      bytes: 128,
    });
    source.prepare = false;
    await source.verify();
    fetch.mockRejectedValue(Error("Network forbidden during timing"));
    expect(await source.read(key, 40, 5)).toEqual(data.subarray(40, 45));
    expect(await source.read(other, 12, 4)).toEqual(data.subarray(12, 16));
    expect(source.reads).toBe(3);
    expect(source.localAssemblies).toBe(2);
  } finally {
    fetch.mockRestore();
    await rm(path, { recursive: true, force: true });
  }
});
