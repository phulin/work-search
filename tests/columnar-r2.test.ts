import { it, expect } from "vitest";
import { ColumnarR2 } from "../src/columnar/r2.js";
import { Reader } from "../src/columnar/storage.js";
import { encodeDocumentPackage } from "../src/columnar/document-package.js";

it("serves R2 pages and grouped documents without CRC metadata, retaining generation, range and document identity checks", async () => {
  const generation = "a".repeat(64),
    key = generation + "/plan-0.bin",
    packet = await encodeDocumentPackage(
      { doc: 37, id: "one", body: "alpha" },
      new Map([["alpha", 1]]),
    );
  let data = packet,
    objectGeneration = generation;
  const bucket = {
    async get() {
      return {
        size: packet.length,
        customMetadata: {
          generation: objectGeneration,
          sha256: generation,
          packageFirst: "37",
          packageEnd: "38",
        },
        async arrayBuffer() {
          return Uint8Array.from(data).buffer;
        },
      };
    },
  } as unknown as R2Bucket;
  const source = new ColumnarR2(bucket),
    root = { generation: "b".repeat(64), objects: [] },
    locator = { key, offset: 0, length: packet.length, first: 37 };
  expect(
    (await source.readPage(key, 0, packet.length, generation)).data,
  ).toEqual(packet);
  const pkg = await new Reader(root, source).document(
    root.generation,
    37,
    locator,
  );
  expect((await pkg.display()).id).toBe("one");
  await expect(
    source.readPage(key, 0, packet.length, "c".repeat(64)),
  ).rejects.toThrow("digest mismatch");
  data = packet.subarray(0, packet.length - 1);
  await expect(source.readPage(key, 0, packet.length)).rejects.toThrow(
    "Truncated",
  );
  await expect(
    new Reader(root, source).document(root.generation, 37, locator),
  ).rejects.toThrow("grouped document identity");
  data = packet.slice();
  new DataView(data.buffer).setUint32(4, 38, true);
  await expect(
    new Reader(root, source).document(root.generation, 37, locator),
  ).rejects.toThrow("Invalid document verification");
  objectGeneration = "c".repeat(64);
  await expect(source.readPage(key, 0, packet.length)).rejects.toThrow(
    "generation mismatch",
  );
  await expect(
    new Reader(root, source).document(root.generation, 37, locator),
  ).rejects.toThrow("generation mismatch");
});
