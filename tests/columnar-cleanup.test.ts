import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { cleanupWorker } from "../bench/columnar/cleanup-worker.js";

describe("construction cleanup", () => {
  it("rejects retained keys, invalid batches and unauthenticated requests without deleting", async () => {
    const keys = [
        ...["a", "b", "c"].map((c) => c.repeat(64) + "/plan-0.bin"),
        "a".repeat(64) + "/root.json",
      ],
      hashes = keys
        .map((k) => createHash("sha256").update(k).digest())
        .sort(Buffer.compare),
      worker = cleanupWorker(Buffer.concat(hashes)),
      deleted: string[][] = [],
      env = {
        INTERNAL_TOKEN: "test",
        INDEX: {
          delete: async (keys: string[]) => {
            deleted.push(keys);
          },
        } as unknown as R2Bucket,
      };
    async function call(body: unknown, auth = "Bearer test") {
      return worker.fetch(
        new Request("https://cleanup.test/", {
          method: "POST",
          headers: { authorization: auth },
          body: JSON.stringify(body),
        }),
        env,
      );
    }
    for (const key of keys) expect((await call([key])).status).toBe(409);
    expect((await call(["source/content.json"])).status).toBe(400);
    expect((await call([keys[0], keys[0]])).status).toBe(400);
    expect((await call([], "wrong")).status).toBe(404);
    expect(deleted).toEqual([]);
    const disposable = "d".repeat(64) + "/plan-0.bin";
    expect((await call([disposable])).status).toBe(200);
    expect(deleted).toEqual([[disposable]]);
    const obsoleteRoot = "e".repeat(64) + "/root.json";
    expect((await call([obsoleteRoot])).status).toBe(200);
    expect(deleted.at(-1)).toEqual([obsoleteRoot]);
  });
});
