import { it, expect } from "vitest";
import {
  documentGroupPairStatistics,
  mergePairStatistics,
  PairStatistics,
} from "../src/columnar/construction/pair-statistics.js";
import { encodeDocumentPackage } from "../src/columnar/document-package.js";
import { concat } from "../src/columnar/format.js";
import { BuildStore, type Chunk } from "../src/columnar/construction/runs.js";
import {
  storePairStatistics,
  mergePairStatisticsRuns,
} from "../src/columnar/construction/pair-statistics-runs.js";
import { statisticsOutput } from "../src/columnar/construction/pair-statistics.js";
it("preserves sorted chunks when overlapping writes complete out of order and propagates failures", async () => {
  const store = new BuildStore({} as R2Bucket),
    objects = new Map<string, Uint8Array>(),
    completed: number[] = [];
  let serial = 0,
    active = 0,
    peak = 0;
  store.put = async (bytes: Uint8Array) => {
    const id = serial++;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, id === 0 ? 20 : 1));
    objects.set(String(id), bytes.slice());
    completed.push(id);
    active--;
    return { key: String(id), size: bytes.length, sha256: String(id) };
  };
  const output = statisticsOutput(65537, 0, 1);
  for (let i = 0; i < 65537; i++) output.put(i, i, 1, i + 1);
  const input = new PairStatistics(output.finish(65537)),
    run = await storePairStatistics(store, input, "words");
  expect(peak).toBe(2);
  expect(completed[0]).toBe(1);
  expect(
    run.chunks.map((chunk) =>
      new PairStatistics(objects.get(chunk.key)!).key(0),
    ),
  ).toEqual([0, 32768, 65536]);
  store.put = async () => {
    throw Error("write failed");
  };
  await expect(storePairStatistics(store, input, "words")).rejects.toThrow(
    "write failed",
  );
  store.get = async () => {
    throw Error("read failed");
  };
  await expect(mergePairStatisticsRuns(store, [run])).rejects.toThrow(
    "read failed",
  );
});
it("counts sparse pairs in a 65536-word vocabulary, including unsigned maximum keys", async () => {
  const selected = Array.from({ length: 65536 }, (_, i) => i),
    ids = new Map([
      ["a", 0],
      ["b", 65535],
    ]),
    pkg = await encodeDocumentPackage(
      { doc: 0, id: "d", body: "b b a b b", title: "b b" },
      ids,
    ),
    stats = new PairStatistics(
      documentGroupPairStatistics(
        pkg,
        Uint32Array.of(0, pkg.length),
        0,
        selected,
      ),
    ),
    rows = new Map(
      Array.from({ length: stats.count }, (_, i) => [
        stats.key(i),
        [stats.df(i), stats.occurrences(i)],
      ]),
    );
  expect(rows.get(0xffffffff)).toEqual([1, 3]);
  expect(rows.get(65535 * 65536)).toEqual([1, 1]);
  expect(rows.get(65535)).toEqual([1, 1]);
});
it("streams more than a million unique pairs across chunk boundaries with exact counts", async () => {
  const objects = new Map<string, Uint8Array>(),
    store = new BuildStore({} as R2Bucket);
  let serial = 0,
    maxChunk = 0;
  store.put = async (bytes: Uint8Array): Promise<Chunk> => {
    const key = String(serial++);
    objects.set(key, bytes.slice());
    maxChunk = Math.max(maxChunk, bytes.length);
    return { key, size: bytes.length, sha256: key };
  };
  store.get = async (ref: Chunk) => objects.get(ref.key)!.slice();
  const runs = [];
  for (let part = 0; part < 2; part++) {
    const writer = statisticsOutput(600001, part * 2, part * 2 + 2);
    for (let i = 0; i < 600000; i++) writer.put(i, i * 2 + part, 1, i + 1);
    writer.put(600000, 0xffffffff, 2, 2 ** 32 + part);
    runs.push(
      await storePairStatistics(
        store,
        new PairStatistics(writer.finish(600001)),
        "vocabulary",
      ),
    );
  }
  const merged = await mergePairStatisticsRuns(store, runs);
  let rows = 0,
    previous = -1;
  for (const chunk of merged.chunks) {
    const stats = new PairStatistics(await store.get(chunk));
    expect([stats.first, stats.end]).toEqual([0, 4]);
    for (let i = 0; i < stats.count; i++) {
      const key = stats.key(i);
      if (key <= previous) throw Error("Unsorted result");
      previous = key;
      if (key === 0xffffffff) {
        expect(stats.df(i)).toBe(4);
        expect(stats.occurrences(i)).toBe(2 ** 33 + 1);
      } else if (
        stats.df(i) !== 1 ||
        stats.occurrences(i) !== Math.floor(key / 2) + 1
      )
        throw Error("Incorrect merged statistic");
      rows++;
    }
  }
  expect(rows).toBe(1200001);
  expect(maxChunk).toBeLessThanOrEqual(16 + 32768 * 16);
  await expect(
    mergePairStatisticsRuns(store, [runs[0], runs[0]]),
  ).rejects.toThrow();
});
it("retains occurrence counts above 32 bits during global merges", () => {
  const make = (first: number) => {
    const bytes = new Uint8Array(32),
      v = new DataView(bytes.buffer);
    v.setUint32(0, 0x31535043, true);
    v.setUint32(4, 1, true);
    v.setUint32(8, first, true);
    v.setUint32(12, first + 2, true);
    v.setUint32(16, 0, true);
    v.setUint32(20, 2, true);
    v.setFloat64(24, 2 ** 32 + 7, true);
    return new PairStatistics(bytes);
  };
  const merged = new PairStatistics(mergePairStatistics([make(0), make(2)]));
  expect(merged.df(0)).toBe(4);
  expect(merged.occurrences(0)).toBe(2 ** 33 + 14);
  expect(() => mergePairStatistics([make(0), make(0)])).toThrow();
});
it("counts adjacent pairs without crossing fields and merges to exhaustive corpus totals", async () => {
  const ids = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]),
    docs = [
      ["a a b c a", "a b"],
      ["b c a a", "a a"],
      ["a d b", "c a"],
      ["a b a b", "a b"],
      ["c b", ""],
    ],
    selected = [2, 0, 1],
    expected = new Map<number, { df: number; occurrences: number }>(),
    runs: PairStatistics[] = [];
  docs.forEach((fields) => {
    const seen = new Set<number>();
    for (const text of fields) {
      const ts = text
        .split(" ")
        .filter(Boolean)
        .map((t) => selected.indexOf(ids.get(t)!));
      for (let p = 0; p + 1 < ts.length; p++)
        if (ts[p] >= 0 && ts[p + 1] >= 0) {
          const key = ts[p] * 3 + ts[p + 1],
            s = expected.get(key) ?? { df: 0, occurrences: 0 };
          s.occurrences++;
          if (!seen.has(key)) s.df++;
          seen.add(key);
          expected.set(key, s);
        }
    }
  });
  for (let first = 0; first < docs.length; first += 2) {
    const packets = [];
    for (let doc = first; doc < Math.min(first + 2, docs.length); doc++)
      packets.push(
        await encodeDocumentPackage(
          { doc, id: String(doc), body: docs[doc][0], title: docs[doc][1] },
          ids,
        ),
      );
    const offsets = [0];
    for (const p of packets) offsets.push(offsets.at(-1)! + p.length);
    runs.push(
      new PairStatistics(
        documentGroupPairStatistics(
          concat(packets),
          Uint32Array.from(offsets),
          first,
          selected,
        ),
      ),
    );
  }
  const merged = new PairStatistics(mergePairStatistics(runs));
  expect(merged.count).toBe(expected.size);
  for (let i = 0; i < merged.count; i++)
    expect({ df: merged.df(i), occurrences: merged.occurrences(i) }).toEqual(
      expected.get(merged.key(i)),
    );
  expect(() => new PairStatistics(merged.bytes.subarray(1))).toThrow();
  expect(() => mergePairStatistics([...runs, ...runs])).toThrow();
});
