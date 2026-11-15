import { expect, it } from "vitest";
import { candidatePairContext } from "../src/columnar/candidate-pair-context.js";
import { concat } from "../src/columnar/format.js";
import {
  encodePairPacket,
  PairPacket,
  type PairRow,
} from "../src/columnar/pair-packet.js";
import type { Reader } from "../src/columnar/storage.js";

function fixture() {
  const rows: PairRow[] = Array.from({ length: 2500 }, (_, doc) => ({
    doc,
    body: Array.from({ length: 8 }, (_, i) => ({
      position: i * 5 + 1,
      previous: i % 2 ? 4 : 0,
      next: 3,
    })),
    title: [{ position: 1, previous: 0, next: 3 }],
  }));
  const chunks = rows.flatMap((r) => [
      encodePairPacket(1, 2, [{ ...r, body: r.body.slice(0, 4), title: [] }]),
      encodePairPacket(1, 2, [{ ...r, body: r.body.slice(4) }]),
    ]),
    raw = concat(chunks),
    reads: number[] = [];
  const stats = {
    positionIntegers: 0,
    pairContextIntegers: 0,
    decodedBytes: 0,
    pairPositionChunks: 0,
    pairPositionBytes: 0,
    anchorBufferBytes: 0,
  };
  const reader = {
    stats,
    named: async (_key: string, n: number) => {
      const at = Number(_key.split("@")[1]);
      reads.push(n);
      return raw.subarray(at, at + n);
    },
  } as unknown as Reader;
  return {
    rows,
    raw,
    reads,
    reader,
    directory: {
      a: 1,
      b: 2,
      generation: "a".repeat(64),
      ranges: [{ object: 0, offset: 0, length: raw.length }],
    },
  };
}
it("refines sparse candidates with complete context across read boundaries and split documents", async () => {
  const f = fixture(),
    docs = Uint32Array.of(0, 777, 2499),
    actual = (await candidatePairContext(
      f.directory,
      docs,
      f.reader,
      1048576,
    ))!,
    full = new PairPacket(encodePairPacket(1, 2, f.rows));
  expect(f.raw.length).toBeGreaterThan(262144);
  expect(f.reads.length).toBe(Math.ceil(f.raw.length / 262144));
  expect(f.reads.every((n) => n <= 262144)).toBe(true);
  expect(f.reader.stats.positionIntegers).toBe(27);
  expect(actual.docs).toEqual(docs);
  for (let i = 0; i < docs.length; i++)
    for (const field of [0, 1]) {
      expect(actual.count(i, field)).toBe(full.count(docs[i], field));
      for (const words of [
        [1, 2],
        [0, 1, 2],
        [1, 2, 3],
        [0, 1, 2, 3],
        [4, 1, 2, 3, 9],
      ]) {
        const at = words[0] === 1 ? 0 : 1;
        expect(actual.phrase(i, field, words, at)).toEqual(
          full.phrase(docs[i], field, words, at),
        );
      }
    }
});
it("abandons optional context when retained candidate evidence exceeds its memory budget", async () => {
  const f = fixture();
  expect(
    await candidatePairContext(f.directory, Uint32Array.of(777), f.reader, 1),
  ).toBeUndefined();
});
it("rejects incomplete or wrongly addressed complete context", async () => {
  const f = fixture();
  await expect(
    candidatePairContext(
      { ...f.directory, b: 8 },
      Uint32Array.of(0),
      f.reader,
      1048576,
    ),
  ).rejects.toThrow("identity");
  f.directory.ranges[0].length--;
  await expect(
    candidatePairContext(f.directory, Uint32Array.of(0), f.reader, 1048576),
  ).rejects.toThrow("Truncated");
});
