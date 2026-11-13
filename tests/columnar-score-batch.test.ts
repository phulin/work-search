import { it, expect } from "vitest";
import { ScoreBatch } from "../src/columnar/score-batch.js";
import { encodeScores } from "../src/columnar/format.js";
it("preserves float64 contributions and field frequencies across reused bands and rejects corrupt blocks", () => {
  const batch = new ScoreBatch(4096),
    docs = Array.from({ length: 128 }, (_, i) => 4050 + i),
    body = docs.map((_, i) => i % 7),
    title = docs.map((_, i) => i % 3),
    b = docs.map((_, i) => Math.log1p(i) * Math.PI),
    t = docs.map((_, i) => 1 / (i + 1));
  const raw = encodeScores(docs, body, title, b, t);
  for (const first of [0, 4096]) {
    batch.reset(first, 4096);
    batch.append(raw, 3);
    const c = batch.columns();
    expect([...c.docs]).toEqual(docs);
    expect([...c.body]).toEqual(body);
    expect([...c.title]).toEqual(title);
    for (let i = 0; i < 128; i++)
      if (docs[i] >= first && docs[i] < first + 4096) {
        const at = docs[i] - first;
        expect([
          c.handle[at],
          c.b[at],
          c.t[at],
          c.blockIndex[i],
          c.blockRow[i],
        ]).toEqual([i + 1, b[i], t[i], 3, i]);
      }
  }
  batch.reset(8192, 2);
  batch.append(encodeScores([8193], [0], [7], [0], [Math.PI]), 0);
  expect([...batch.columns().docs]).toEqual([8193]);
  expect([...batch.handle.subarray(0, 3)]).toEqual([0, 1, 0]);
  expect(batch.b.every((n) => n === 0)).toBe(true);
  expect(() => batch.append(raw, 1)).toThrow("Unsorted");
  batch.reset(0, 4096);
  expect(() => batch.append(raw.subarray(0, raw.length - 1), 0)).toThrow();
  const corrupt = raw.slice();
  new DataView(corrupt.buffer).setUint32(20, 0xffffffff, true);
  expect(() => batch.append(corrupt, 0)).toThrow();
});
