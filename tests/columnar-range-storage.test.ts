import { it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RangeStorage } from "../bench/columnar/range-storage.js";
import { createHash } from "node:crypto";
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
