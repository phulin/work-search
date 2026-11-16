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

it("scores only admitted rows of sparse blocks without losing field frequencies or positional row addresses", () => {
  const root = { count: 10000, avgBody: 1100.25, avgTitle: 6.75 },
    df = 3000;
  for (const n of [37, 128])
    for (const width of [1, 7, 16, 31, 32]) {
      const batch = new ScoreBatch(256, scoreParameters(df, root)),
        docs = Array.from({ length: n }, (_, i) => 1000 + i * 2),
        body = docs.map((_, i) => (i % 3 ? 2 ** width - 1 : 0)),
        title = docs.map((_, i) => (i % 2 ? 1 : 0)),
        bl = body.map((tf) => Math.max(150, tf)),
        tl = title.map(() => 7),
        raw = encodeScores(docs, body, title, bl, tl),
        selected = new Set([0, 1, n - 1]),
        mask = new Uint8Array(256);
      for (const row of selected) mask[docs[row] - 1000] = 1;
      batch.reset(1000, 256);
      batch.append(raw, 9, mask);
      expect(batch.frequencyIntegers).toBeLessThan(n * 4);
      expect([...batch.columns().docs]).toEqual(docs);
      for (let row = 0; row < n; row++) {
        const d = docs[row] - 1000;
        if (!selected.has(row)) {
          expect([batch.handle[d], batch.b[d], batch.t[d]]).toEqual([0, 0, 0]);
          continue;
        }
        expect(batch.handle[d]).toBe(row + 1);
        expect(batch.body[row]).toBe(body[row]);
        expect(batch.title[row]).toBe(title[row]);
        expect(batch.blockIndex[row]).toBe(9);
        expect(batch.blockRow[row]).toBe(row);
        expect(batch.b[d]).toBe(
          bm25(body[row], df, root.count, bl[row], root.avgBody),
        );
        expect(batch.t[d]).toBe(
          bm25(title[row], df, root.count, tl[row], root.avgTitle),
        );
      }
      // The same workspace must subsequently decode a dense block in full.
      batch.reset(1000, 256);
      batch.append(raw, 10);
      for (let row = 0; row < n; row++) {
        expect(batch.body[row]).toBe(body[row]);
        expect(batch.title[row]).toBe(title[row]);
        expect(batch.handle[docs[row] - 1000]).toBe(row + 1);
      }
    }
});
