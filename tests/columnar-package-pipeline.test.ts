import { expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { packagePipeline } from "../src/columnar/package-batches.js";
const gate = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
it("replenishes a completed slot before the slowest neighboring request finishes", async () => {
  const gates = Array.from({ length: 4 }, () => gate<number>()),
    started: number[] = [];
  const pipeline = packagePipeline(
    [0, 1, 2, 3],
    () => 1,
    (n) => {
      started.push(n);
      return gates[n].promise;
    },
    undefined,
    4,
    2,
  );
  const first = pipeline.next();
  await setImmediate();
  expect(started).toEqual([0, 1]);
  gates[1].resolve(10);
  expect((await first).value).toEqual({ item: 1, value: 10 });
  expect(started).toEqual([0, 1, 2]);
  const second = pipeline.next();
  gates[2].resolve(20);
  expect((await second).value).toEqual({ item: 2, value: 20 });
  expect(started).toEqual([0, 1, 2, 3]);
  gates[0].resolve(0);
  gates[3].resolve(30);
  const remaining: number[] = [];
  for await (const result of pipeline) remaining.push(result.item);
  expect(remaining.sort()).toEqual([0, 3]);
});
it("reserves in-flight, buffered and consumed packages together and runs oversized packages alone", async () => {
  const states: { bytes: number; items: number[]; pending: number }[] = [];
  async function* input() {
    yield* [2, 10, 3, 1, 2];
  }
  const got: number[] = [];
  for await (const { item } of packagePipeline(
    input(),
    (n) => n,
    async (n) => n,
    (state) => {
      states.push({
        bytes: [...state.reserved.values()].reduce((n, r) => n + r.bytes, 0),
        items: [...state.reserved.values()].map((r) => r.item),
        pending: state.pending,
      });
    },
    4,
    2,
  ))
    got.push(item);
  expect(got.sort((a, b) => a - b)).toEqual([1, 2, 2, 3, 10]);
  for (const s of states) {
    expect(s.pending).toBeLessThanOrEqual(2);
    if (s.bytes > 4) expect(s.items).toEqual([10]);
  }
  expect(states.at(-1)).toEqual({ bytes: 0, items: [], pending: 0 });
});
it("handles rejected reads, drains outstanding work and never starts later candidates", async () => {
  const gates = [gate<number>(), gate<number>()],
    started: number[] = [];
  const pipeline = packagePipeline(
    [0, 1, 2],
    () => 1,
    (n) => {
      started.push(n);
      return gates[n].promise;
    },
    undefined,
    3,
    2,
  );
  const pending = expect(pipeline.next()).rejects.toThrow("failed");
  await setImmediate();
  gates[1].reject(Error("failed"));
  await setImmediate();
  gates[0].resolve(0);
  await pending;
  expect(started).toEqual([0, 1]);
  expect((await pipeline.next()).done).toBe(true);
});
