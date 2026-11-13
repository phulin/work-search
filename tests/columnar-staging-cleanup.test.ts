import { expect, it, vi } from "vitest";
import worker from "../src/columnar/upload-worker.js";
it("deletes only authenticated temporary streams and rejects an entire mixed batch", async () => {
  const digest = "a".repeat(64),
    key = `${digest}/stage-${digest}.bin`,
    remove = vi.fn(async () => {}),
    env = {
      INDEX: { delete: remove } as unknown as R2Bucket,
      UPLOAD_TOKEN: "test",
    },
    call = (keys: unknown, token = "test") =>
      worker.fetch(
        new Request("https://test/__delete-staging", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(keys),
        }),
        env,
      );
  for (const keys of [
    [],
    null,
    [key, key],
    [key, `${digest}/plan-0.bin`],
    [key, `${digest}/root.json`],
    [key, `${digest}/stage-${"b".repeat(64)}.bin`],
    Array(1001).fill(key),
    [key, 1],
  ])
    expect((await call(keys)).status).toBe(400);
  expect((await call([key], "other")).status).toBe(404);
  expect(remove).not.toHaveBeenCalled();
  expect(await (await call([key])).json()).toEqual({ deleted: 1 });
  expect(remove).toHaveBeenCalledExactlyOnceWith([key]);
});
