import { it, expect } from "vitest";
import { EmpiricalModel, Slots } from "../bench/demo-model.js";
import { context, tracedBucket, type Trace } from "../bench/demo-trace.js";

it("resamples measured pairs reproducibly and keeps fixed-delay controls explicit", () => {
  const samples = [
    {
      headersMs: 80,
      bodyMs: 5,
      bytes: 16384,
      round: 0,
      concurrency: 1,
      cohort: "varied-range",
    },
    {
      headersMs: 140,
      bodyMs: 10,
      bytes: 16384,
      round: 0,
      concurrency: 1,
      cohort: "varied-range",
    },
    {
      headersMs: 900,
      bodyMs: 999,
      bytes: 16384,
      round: 0,
      concurrency: 12,
      cohort: "varied-range",
    },
  ];
  const a = new EmpiricalModel(samples, 7),
    b = new EmpiricalModel(samples, 7);
  const draws = Array.from({ length: 100 }, () => a.sample(16384));
  expect(draws).toEqual(Array.from({ length: 100 }, () => b.sample(16384)));
  expect(new Set(draws.map((d) => d.headersMs))).toEqual(new Set([80, 140]));
  expect(
    draws.every(
      (d) =>
        (d.headersMs === 80 && d.bodyMs === 5) ||
        (d.headersMs === 140 && d.bodyMs === 10),
    ),
  ).toBe(true);
  expect(new EmpiricalModel(samples, 7, "fixed20").sample(16384)).toEqual({
    headersMs: 20,
    bodyMs: 0,
  });
});
it("queues header waits and releases slots idempotently without waiting for body consumption", async () => {
  const slots = new Slots(1);
  const release = await slots.acquire();
  let waiting = true;
  const task = slots.acquire().then((r) => {
    waiting = false;
    return r;
  });
  await Promise.resolve();
  expect(waiting).toBe(true);
  release();
  release();
  const second = await task;
  expect(waiting).toBe(false);
  second();
  (await slots.acquire())();
});
it("keeps concurrent traces separate while retaining the same cache-key bucket", async () => {
  const base = {
    get: async (key: string) => {
      await new Promise((r) => setTimeout(r, 1));
      return {
        customMetadata: {},
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      };
    },
  } as unknown as R2Bucket;
  const bucket = tracedBucket(base);
  expect(tracedBucket(base)).toBe(bucket);
  const a: Trace = { start: performance.now(), events: [] },
    b: Trace = { start: performance.now(), events: [] };
  await Promise.all([
    context.run(a, async () => {
      await (await bucket.get("one"))!.arrayBuffer();
    }),
    context.run(b, async () => {
      await (await bucket.get("two"))!.arrayBuffer();
    }),
  ]);
  expect(a.events.map((e) => e.key)).toEqual(["one"]);
  expect(b.events.map((e) => e.key)).toEqual(["two"]);
  expect(a.events[0].bytes).toBe(2);
  expect(a.events[0].end).toBeGreaterThanOrEqual(a.events[0].headers!);
});
