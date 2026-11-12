import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packCards } from "../src/content/cards-build.js";
import { ResultCards } from "../src/content/cards.js";
it("packs generation-bound cards and body pointers without changing an index bundle", async () => {
  const out = await mkdtemp(join(tmpdir(), "cards-")),
    generation = "a".repeat(64),
    records = Array.from({ length: 259 }, (_, doc) => ({
      doc,
      id: "d" + doc,
      title: "Café " + doc,
      metadata: { court: "Test" },
      body: [0, doc * 100, 100, 123],
    }));
  try {
    async function* source() {
      yield* records;
    }
    const manifest = await packCards(
      out,
      generation,
      records.length,
      source(),
      "b".repeat(64),
    );
    let gets = 0;
    const bucket = {
      get: async (key: string, options?: any) => {
        gets++;
        const bytes = await readFile(out + "/" + key.split("/").at(-1));
        const b = options?.range
          ? bytes.subarray(
              options.range.offset,
              options.range.offset + options.range.length,
            )
          : bytes;
        return {
          customMetadata: { generation: key.split("/")[0] },
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        };
      },
    } as unknown as R2Bucket;
    const cards = new ResultCards(bucket);
    expect(await cards.get(generation, 258, "d258")).toEqual(records[258]);
    expect(await cards.get(generation, 0, "d0")).toEqual(records[0]);
    expect(gets).toBe(3);
    expect(await cards.get(generation, 0, "d0")).toEqual(records[0]);
    expect(gets).toBe(3);
    await expect(cards.get(generation, 0, "wrong")).rejects.toThrow(/identity/);
    await expect(cards.get(generation, 259, "d259")).rejects.toThrow(/range/);
    expect(manifest.root.size).toBe(80 + 3 * 16);
    const broken = {
      get: async (key: string, options?: any) => {
        const o = await bucket.get(key, options);
        const b = new Uint8Array(await (o as R2ObjectBody).arrayBuffer());
        b[0] ^= 1;
        return {
          customMetadata: { generation: key.split("/")[0] },
          arrayBuffer: async () => b.buffer,
        };
      },
    } as unknown as R2Bucket;
    await expect(
      new ResultCards(broken).get(generation, 0, "d0"),
    ).rejects.toThrow();
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
it("falls back when older generations have no cards and caches that absence briefly", async () => {
  let calls = 0;
  const cards = new ResultCards({
    get: async () => {
      calls++;
      return null;
    },
  } as unknown as R2Bucket);
  expect(await cards.get("a".repeat(64), 1, "x")).toBeNull();
  expect(await cards.get("a".repeat(64), 2, "y")).toBeNull();
  expect(calls).toBe(1);
});
