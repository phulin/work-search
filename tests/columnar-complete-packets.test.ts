import { expect, it } from "vitest";
import { Reader, Memory, Lru } from "../src/columnar/storage.js";
import { PAGE, type Ref } from "../src/columnar/format.js";
it("reads a complete immutable extent once without page assembly, and scopes cached extents by generation and namespace", async () => {
  const generation = "a".repeat(64),
    key = "b".repeat(64) + "/plan-0.bin",
    bytes = Uint8Array.from({ length: 5 * PAGE }, (_, i) => i % 251),
    ref: Ref = [0, 31, 900 * 1024],
    root = {
      generation,
      objects: [
        { name: "plan-0.bin", key, size: bytes.length, sha256: "b".repeat(64) },
      ],
    },
    shared = new Map<string, Uint8Array>();
  let reads = 0;
  const source = {
      read: async () => {
        throw Error("Unexpected paged read");
      },
      readNamed: async (address: string, length: number) => {
        reads++;
        expect(address).toBe(key + "@31");
        expect(length).toBe(ref[2]);
        return bytes.slice(31, 31 + length);
      },
    },
    cache = {
      get: async (key: string) => shared.get(key),
      put: async (key: string, b: Uint8Array) => {
        shared.set(key, b);
      },
    },
    memory = new Memory();
  memory.pages = new Lru(2 * 1048576);
  const reader = new Reader(root, source, memory, cache, "first"),
    [a, b] = await reader.completePackets([ref, ref]);
  expect(a).toEqual(bytes.subarray(31, 31 + ref[2]));
  expect(b).toBe(a);
  expect(reads).toBe(1);
  expect(reader.stats.bytes).toBe(ref[2]);
  expect(reader.stats.deduplicated).toBe(1);
  expect(await reader.packet([0, 100, 500])).toEqual(bytes.subarray(100, 600));
  expect(reads).toBe(1);
  expect(await reader.completePackets([ref])).toEqual([a]);
  expect(reads).toBe(1);
  await Promise.all(reader.sharedWrites);
  const second = new Reader(root, source, new Memory(), cache, "first");
  expect((await second.completePackets([ref]))[0]).toEqual(a);
  expect(second.stats.sharedGets).toBe(1);
  expect(second.stats.requests).toBe(0);
  await new Reader(root, source, new Memory(), cache, "other").completePackets([
    ref,
  ]);
  expect(reads).toBe(2);
  await expect(
    reader.completePackets([[0, bytes.length - 1, 2]]),
  ).rejects.toThrow();
  expect(reads).toBe(2);
});
it("uses seeded data and retains page reads for sources without immutable extent reads", async () => {
  const generation = "a".repeat(64),
    bytes = Uint8Array.from({ length: PAGE + 7 }, (_, i) => i % 251),
    ref: Ref = [0, 17, 8192];
  let reads = 0;
  const reader = new Reader(
    {
      generation,
      objects: [{ name: "plan-0.bin", size: bytes.length, sha256: generation }],
    },
    {
      read: async (_key, offset, length) => {
        reads++;
        return bytes.slice(offset, offset + length);
      },
    },
  );
  expect((await reader.completePackets([ref]))[0]).toEqual(
    bytes.subarray(17, 17 + 8192),
  );
  expect(reads).toBe(1);
  const seeded: Ref = [0, PAGE, 7];
  reader.seed(seeded, bytes.slice(PAGE));
  expect((await reader.completePackets([seeded]))[0]).toEqual(
    bytes.slice(PAGE),
  );
  expect(reads).toBe(1);
});
