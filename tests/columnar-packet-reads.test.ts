import { it, expect } from "vitest";
import { Reader, Memory } from "../src/columnar/storage.js";
import { PAGE } from "../src/columnar/format.js";
import { crc32 } from "../src/format/codec.js";
it("preserves complete reads after the shared-cache operation budget is exhausted", async () => {
  const data = Uint8Array.of(1, 2, 3, 4),
    checksum = crc32(data),
    root = {
      generation: "g",
      objects: Array.from({ length: 1100 }, (_, i) => ({
        name: String(i),
        size: 4,
        sha256: "x",
        checksums: [checksum],
      })),
    };
  let operations = 0,
    reads = 0;
  const reader = new Reader(
    root,
    {
      async read() {
        reads++;
        return data.slice();
      },
    },
    new Memory(),
    {
      async get() {
        operations++;
        return undefined;
      },
      async put() {
        operations++;
      },
    },
  );
  const result = await reader.many(root.objects.map((_, i) => [i, 0, 4]));
  expect(result).toHaveLength(1100);
  expect(result.every((b) => b.length === 4 && b[0] === 1 && b[3] === 4)).toBe(
    true,
  );
  expect(reads).toBe(1100);
  expect(operations).toBe(900);
  expect(reader.stats.sharedGets + reader.stats.sharedPuts).toBe(900);
  expect(reader.stats.sharedBudgetBypasses).toBeGreaterThan(0);
});
it("uses one contiguous GET for 900 KiB, reuses independent pages, coalesces adjacent streams and rejects corruption", async () => {
  const data = Uint8Array.from(
      { length: PAGE * 6 + 131 },
      (_, i) => (i * 17 + (i >>> 11)) & 255,
    ),
    checksums = [];
  for (let i = 0; i < data.length; i += PAGE)
    checksums.push(crc32(data.subarray(i, i + PAGE)));
  const root = {
      generation: "g",
      objects: [{ name: "o", size: data.length, sha256: "x", checksums }],
    },
    calls: { offset: number; length: number }[] = [],
    shared = new Map<string, Uint8Array>(),
    memory = new Memory(),
    source = {
      async read(_key: string, offset: number, length: number) {
        calls.push({ offset, length });
        return data.slice(offset, offset + length);
      },
    },
    cache = {
      async get(k: string) {
        return shared.get(k);
      },
      async put(k: string, v: Uint8Array) {
        shared.set(k, v);
      },
    };
  const r = new Reader(root, source, memory, cache);
  const [a, b] = await Promise.all([
    r.packet([0, 19, 900 * 1024]),
    r.packet([0, 19, 900 * 1024]),
  ]);
  expect(a).toEqual(data.subarray(19, 19 + 900 * 1024));
  expect(b).toEqual(a);
  expect(calls).toEqual([{ offset: 0, length: PAGE * 4 }]);
  expect(memory.pages.entries.size).toBe(4);
  expect(
    [...memory.pages.entries.values()].every(
      (e) => e.value.buffer.byteLength <= PAGE,
    ),
  ).toBe(true);
  memory.clear();
  await new Reader(root, source, memory, cache).packet([0, PAGE + 17, 300]);
  expect(calls).toHaveLength(1);
  memory.clear();
  shared.clear();
  const r2 = new Reader(root, source, memory, cache);
  const x = await r2.packets([
    [0, 100, 1000],
    [0, PAGE + 100, 1000],
  ]);
  expect(x[0]).toEqual(data.subarray(100, 1100));
  expect(x[1]).toEqual(data.subarray(PAGE + 100, PAGE + 1100));
  expect(calls.at(-1)).toEqual({ offset: 0, length: PAGE * 2 });
  const bad = {
    async read(_k: string, o: number, n: number) {
      const b = data.slice(o, o + n);
      b[100] ^= 1;
      return b;
    },
  };
  await expect(
    new Reader(root, bad).packet([0, 0, 900 * 1024]),
  ).rejects.toThrow("checksum");
  const tail = await new Reader(root, source).packet([0, PAGE * 6 + 20, 111]);
  expect(tail).toEqual(data.subarray(PAGE * 6 + 20));
  expect(calls.at(-1)).toEqual({ offset: PAGE * 6, length: 131 });
});
