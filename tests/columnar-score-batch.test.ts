import { it, expect } from "vitest";
import { ScoreBatch } from "../src/columnar/score-batch.js";
import { encodeScores, decodeScores } from "../src/columnar/format.js";
import { scoreParameters } from "../src/columnar/scoring.js";
import { bm25 } from "../src/query/engine.js";
it("computes the original BM25 formula from packed frequencies and lengths across reused bands", () => {
  const root = { count: 10000, avgBody: 1100.25, avgTitle: 6.75 },
    df = 3000,
    batch = new ScoreBatch(4096, scoreParameters(df, root)),
    docs = Array.from({ length: 128 }, (_, i) => 4050 + i),
    body = docs.map((_, i) => i % 7),
    title = docs.map((_, i) => i % 3),
    bl = docs.map((_, i) => i * 375 + 150),
    tl = docs.map((_, i) => i + 4),
    b = docs.map((_, i) => bm25(body[i], df, root.count, bl[i], root.avgBody)),
    t = docs.map((_, i) =>
      bm25(title[i], df, root.count, tl[i], root.avgTitle),
    ),
    raw = encodeScores(docs, body, title, bl, tl);
  const scalar = decodeScores(raw, scoreParameters(df, root));
  for (let i = 0; i < docs.length; i++) {
    expect(scalar.b.getFloat64(i * 8, true)).toBe(b[i]);
    expect(scalar.t.getFloat64(i * 8, true)).toBe(t[i]);
  }
  // Lengths replace 16 bytes of scores per row, including absent-field zeros.
  expect(raw.length).toBeLessThan(128 * 16);
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
  batch.append(encodeScores([8193], [0], [7], [0], [13]), 0);
  expect([...batch.columns().docs]).toEqual([8193]);
  expect([...batch.handle.subarray(0, 3)]).toEqual([0, 1, 0]);
  expect(batch.b.every((n) => n === 0)).toBe(true);
  expect(batch.t[1]).toBe(bm25(7, df, root.count, 13, root.avgTitle));
  expect(() => batch.append(raw, 1)).toThrow("Unsorted");
  batch.reset(0, 4096);
  expect(() => batch.append(raw.subarray(0, raw.length - 1), 0)).toThrow();
  const corrupt = raw.slice();
  new DataView(corrupt.buffer).setUint32(24, 0xffffffff, true);
  expect(() => batch.append(corrupt, 0)).toThrow();
});
