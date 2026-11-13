import { it, expect } from "vitest";
import { Reader, Memory, Lru } from "../src/columnar/storage.js";
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

it("retains independent pages across LRU eviction and concurrent grouped reads, copying only crossing blocks", async () => {
  const data = Uint8Array.from(
      { length: PAGE * 3 + 17 },
      (_, i) => (i * 13 + (i >>> 15)) & 255,
    ),
    checksums = Array.from({ length: 4 }, (_, i) =>
      crc32(data.subarray(i * PAGE, (i + 1) * PAGE)),
    ),
    root = {
      generation: "g",
      objects: [{ name: "o", size: data.length, sha256: "x", checksums }],
    },
    memory = new Memory();
  memory.pages = new Lru(PAGE);
  let reads = 0;
  const source = {
      async read(_k: string, offset: number, length: number) {
        reads++;
        return data.slice(offset, offset + length);
      },
    },
    r = new Reader(root, source, memory),
    refs: [number, number, number][] = [
      [0, PAGE - 17, 41],
      [0, PAGE + 99, 100],
      [0, PAGE * 2 + 5, 10],
      [0, PAGE * 3 + 2, 15],
    ],
    [a, b] = await Promise.all([r.packets(refs), r.packets(refs)]);
  expect(reads).toBe(1);
  refs.forEach((ref, i) => {
    expect(a[i]).toEqual(data.subarray(ref[1], ref[1] + ref[2]));
    expect(b[i]).toEqual(a[i]);
  });
  expect(a[0].buffer.byteLength).toBe(41);
  expect(a[1].buffer.byteLength).toBe(PAGE);
  expect(a[1].buffer).toBe(b[1].buffer);
  expect(a[2].buffer.byteLength).toBe(PAGE);
  expect(a[3].buffer.byteLength).toBe(17);
  expect(r.stats.packetCopyBytes).toBe(82);
  memory.clear();
  expect(a[1]).toEqual(data.subarray(PAGE + 99, PAGE + 199));
  const corrupt = {
    async read(k: string, offset: number, length: number) {
      const raw = await source.read(k, offset, length);
      raw[PAGE + 120] ^= 1;
      return raw;
    },
  };
  await expect(new Reader(root, corrupt).packets(refs)).rejects.toThrow(
    "checksum",
  );
  await expect(new Reader(root, source).packets([[0, -1, 10]])).rejects.toThrow(
    "reference",
  );
});
