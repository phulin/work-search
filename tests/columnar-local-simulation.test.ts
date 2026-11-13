import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalObjects } from "../bench/columnar/local-storage.js";
import { SimulatedIO } from "../bench/columnar/latency-model.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { PAGE, concat, type Root, type Ref } from "../src/columnar/format.js";
import { encodeDocumentPackage } from "../src/columnar/document-package.js";
import { crc32 } from "../src/format/codec.js";

it("prepares immutable ranges and packages once, replays offline, and rejects damaged package bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-local-")),
    digest = (data: Uint8Array) =>
      createHash("sha256").update(data).digest("hex"),
    pages = new Uint8Array(PAGE + 100).map((_, i) => i % 251),
    key = digest(pages) + "/plan-0.bin",
    packages = await Promise.all(
      ["alpha beta", "beta alpha beta"].map((body, doc) =>
        encodeDocumentPackage(
          { id: `d${doc}`, doc, body, title: "Alpha" },
          new Map([
            ["alpha", 1],
            ["beta", 2],
          ]),
        ),
      ),
    ),
    group = concat(packages),
    groupKey = digest(group) + "/plan-0.bin",
    root = {
      count: 2,
      generation: "a".repeat(64),
      objects: [
        {
          name: "plan-0.bin",
          key,
          size: pages.length,
          sha256: digest(pages),
          checksums: [
            crc32(pages.subarray(0, PAGE)),
            crc32(pages.subarray(PAGE)),
          ],
        },
      ],
    } as Root;
  let fetches = 0;
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    fetches++;
    const headers = new Headers(options.headers),
      whole = url.endsWith(groupKey),
      data = whole ? group : pages,
      start = Number(headers.get("x-offset") ?? 0),
      length = Number(headers.get("x-length") ?? data.length),
      selectedKey = whole ? groupKey : key;
    const checksums = Buffer.alloc(8);
    packages.forEach((p, i) => checksums.writeUInt32LE(crc32(p), i * 4));
    return new Response(data.slice(start, start + length), {
      headers: {
        "x-generation": selectedKey.split("/")[0],
        "x-sha256": digest(data),
        ...(whole
          ? {
              "x-package-first": "0",
              "x-package-end": "2",
              "x-package-crc32": checksums.toString("base64"),
            }
          : {}),
      },
    });
  });
  try {
    const source = new LocalObjects(root, dir, {
      url: "https://immutable.invalid",
      token: "test",
    });
    await expect(source.read(key, 0, PAGE)).rejects.toThrow(
      "run preparation first",
    );
    source.remoteEnabled = true;
    expect(await source.read(key, 0, PAGE)).toEqual(pages.subarray(0, PAGE));
    const locator = {
      key: groupKey,
      offset: packages[0].length,
      length: packages[1].length,
      first: 0,
    };
    const pkg = await new Reader(root, source).document(
      "b".repeat(64),
      1,
      locator,
    );
    expect((await pkg.display()).id).toBe("d1");
    expect([...pkg.tokens(0)]).toEqual([2, 1, 2]);
    expect(fetches).toBe(2);
    await expect(stat(dir + "/objects/" + groupKey)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const offline = new LocalObjects(root, dir);
    expect(await offline.read(key, 0, PAGE)).toEqual(
      Buffer.from(pages.subarray(0, PAGE)),
    );
    expect(
      (
        await (
          await new Reader(root, offline).document("b".repeat(64), 1, locator)
        ).display()
      ).id,
    ).toBe("d1");
    await expect(offline.read(key, PAGE, 100)).rejects.toThrow(
      "run preparation first",
    );
    expect(fetches).toBe(2);
    group[packages[0].length + 20] ^= 1;
    await writeFile(dir + "/objects/" + groupKey, group);
    await expect(
      new Reader(root, offline).document("b".repeat(64), 1, locator),
    ).rejects.toThrow("Document package digest mismatch");
  } finally {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});

it("models overlapping physical reads in six-slot waves and charges no origin delay for memory hits", async () => {
  vi.useFakeTimers();
  try {
    const bytes = new Uint8Array(PAGE * 7),
      root = {
        generation: "a".repeat(64),
        objects: [
          {
            name: "plan-0.bin",
            size: bytes.length,
            sha256: "b".repeat(64),
            checksums: Array(7).fill(crc32(bytes.subarray(0, PAGE))),
          },
        ],
      },
      base = {
        read: async (_key: string, offset: number, length: number) =>
          bytes.subarray(offset, offset + length),
      },
      modeled = new SimulatedIO(base, {
        r2Ms: 10,
        sharedMs: 1,
        r2MiBPerSecond: 1e12,
        sharedMiBPerSecond: 1e12,
        jitterMs: 0,
        seed: 1,
      }),
      memory = new Memory(),
      refs: Ref[] = Array.from({ length: 7 }, (_, i) => [0, i * PAGE, 1]),
      reader = new Reader(root, modeled.source, memory);
    let done = false;
    const read = reader.many(refs).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(done).toBe(false);
    expect(modeled.calls.r2).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(modeled.calls.r2).toBe(7);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await read;
    expect(done).toBe(true);
    const next = new Reader(root, modeled.source, memory);
    await next.many(refs);
    expect(next.stats.memoryHits).toBe(7);
    expect(modeled.calls.r2).toBe(7);
  } finally {
    vi.useRealTimers();
  }
});
