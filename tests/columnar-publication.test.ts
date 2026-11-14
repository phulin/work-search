import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  publicationBody,
  publishBatch,
  inspectPublication,
} from "../src/columnar/publication.js";
function packet(rows: { key: string; data: string }[]) {
  const bodies = rows.map((r) => Buffer.from(r.data));
  const manifest = Buffer.from(
    JSON.stringify(
      rows.map((r, i) => ({
        key: r.key,
        size: bodies[i].length,
        sha256: createHash("sha256").update(bodies[i]).digest("hex"),
      })),
    ),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(manifest.length);
  return Buffer.concat([header, manifest, ...bodies]);
}
it("publishes complete immutable batches, safely resumes partial publication, and refuses conflicts", async () => {
  const stored = new Map<
    string,
    { size: number; customMetadata: Record<string, string>; body: Buffer }
  >();
  const bucket = {
    head: async (k: string) => stored.get(k) ?? null,
    put: async (k: string, b: Uint8Array, o: any) => {
      expect(o.onlyIf.get("If-None-Match")).toBe("*");
      if (stored.has(k)) return null;
      expect(createHash("sha256").update(b).digest("hex")).toBe(o.sha256);
      const row = {
        size: b.length,
        body: Buffer.from(b),
        customMetadata: o.customMetadata,
      };
      stored.set(k, row);
      return row;
    },
  } as unknown as R2Bucket;
  const key = "a".repeat(64) + "/presence-1.bin";
  const bytes = packet([{ key, data: "first" }]);
  expect(await publishBatch(bucket, bytes)).toMatchObject({
    stored: 1,
    existing: 0,
    objects: 1,
  });
  expect(await publishBatch(bucket, bytes)).toMatchObject({
    stored: 0,
    existing: 1,
  });
  await expect(
    publishBatch(bucket, packet([{ key, data: "other" }])),
  ).rejects.toThrow("Immutable conflict");
  const rows = await inspectPublication(bucket, [
    key,
    "b".repeat(64) + "/plan-0.bin",
  ]);
  expect(rows.map((r) => r.status)).toEqual([200, 404]);
  expect(rows[0].headers["x-generation"]).toBe("a".repeat(64));
  expect(stored.get(key)?.body.toString()).toBe("first");
  await expect(
    publishBatch(bucket, bytes.subarray(0, bytes.length - 1)),
  ).rejects.toThrow("payload size");
  await expect(
    publishBatch(
      bucket,
      packet([
        { key, data: "x" },
        { key, data: "x" },
      ]),
    ),
  ).rejects.toThrow("records");
  await expect(
    inspectPublication(bucket, ["casework/catalog.json"]),
  ).rejects.toThrow("inspection");
});
it("bounds expanded publication buffers and rejects truncated or oversized transport", async () => {
  const request = (s: string, n: number) =>
    new Request("https://upload/__publish-batch", {
      method: "POST",
      body: s,
      headers: { "x-raw-length": String(n), "x-transport": "raw" },
    });
  expect(await publicationBody(request("hello", 5))).toEqual(
    new TextEncoder().encode("hello"),
  );
  await expect(publicationBody(request("hell", 5))).rejects.toThrow(
    "Truncated",
  );
  await expect(publicationBody(request("hello!", 5))).rejects.toThrow(
    "exceeds",
  );
  await expect(publicationBody(request("hello", 9 * 1048576))).rejects.toThrow(
    "size",
  );
});
it("waits for outstanding writes before releasing a failed batch", async () => {
  let release!: (object: R2Object | null) => void;
  const pending = new Promise<R2Object | null>((resolve) => {
    release = resolve;
  });
  const bucket = {
    put: async (key: string) => {
      if (key.endsWith("presence-0.bin"))
        throw Error("transient write failure");
      return pending;
    },
  } as unknown as R2Bucket;
  let settled = false;
  const result = publishBatch(
    bucket,
    packet([
      { key: "a".repeat(64) + "/presence-0.bin", data: "one" },
      { key: "a".repeat(64) + "/presence-1.bin", data: "two" },
    ]),
  ).catch((error) => {
    settled = true;
    return error;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release({} as R2Object);
  expect(await result).toMatchObject({ message: "transient write failure" });
});
