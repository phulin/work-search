import { expect, it } from "vitest";
import { rowRecord } from "../src/columnar/construction/runs.js";
import { concat, pack, u32, unpack, view } from "../src/columnar/format.js";

function check(body: number[], title: number[]) {
  const b = pack(body, true),
    t = pack(title, true);
  const row = rowRecord(917, 4000, 20, body, title);
  expect(row).toEqual(
    concat([
      u32([28 + b.length + t.length, 2, 917, 4000, 20, b.length, t.length]),
      b,
      t,
    ]),
  );
  expect([...unpack(row.subarray(28, 28 + b.length))]).toEqual(body);
  expect([...unpack(row.subarray(28 + b.length))]).toEqual(title);
  return row;
}

it("retains position bytes for every packing width and unsigned restart", () => {
  for (let width = 0; width <= 32; width++) {
    const maximum = 2 ** width - 1;
    const positions = [0, maximum, maximum];
    const row = check(positions, [0xffffffff, 0xffffffff]);
    expect(view(row).getUint8(36)).toBe(width);
    check([], positions);
    for (const n of [31, 32, 33, 127, 128, 129]) {
      const tail = Array(n).fill(0);
      tail[n - 1] = maximum;
      check(tail, []);
    }
  }
  check([5, 6, 9], []);
  expect([...rowRecord(0, 10, 0, [5, 6, 9], []).subarray(28, 44)]).toEqual([
    3, 0, 0, 0, 5, 0, 0, 0, 2, 1, 0, 0, 52, 0, 0, 0,
  ]);
});

it("preserves empty, constant, crossing-word and short-tail position streams", () => {
  let seed = 576814;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const n of [0, 1, 2, 3, 31, 32, 33, 127, 128, 129, 2049]) {
    for (let repetition = 0; repetition < 10; repetition++) {
      let position = random() % 100000;
      const body = Array.from(
        { length: n },
        () => (position += random() % 10007),
      );
      const title = Array.from({ length: repetition }, (_, i) => i * 3 + 4);
      check(body, title);
      check(Array(n).fill(123), []);
    }
  }
});

it("rejects invalid positions in either field", () => {
  for (const invalid of [
    [-1],
    [1, 0],
    [0, 0x100000000],
    [0.5],
    [NaN],
    [Infinity],
    [0, NaN],
  ]) {
    expect(() => rowRecord(0, 0, 0, invalid, [])).toThrow(
      "Invalid packed integer",
    );
    expect(() => rowRecord(0, 0, 0, [], invalid)).toThrow(
      "Invalid packed integer",
    );
  }
});
