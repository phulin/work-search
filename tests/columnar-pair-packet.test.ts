import { it, expect } from "vitest";
import {
  encodePairPacket,
  PairPacket,
  intersectPairDocuments,
  type PairRow,
  pairPacketByteBound,
} from "../src/columnar/pair-packet.js";
it("pair context exactly proves short phrases, repeated terms and field boundaries against exhaustive tokens", () => {
  let seed = 71;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const docs = Array.from({ length: 80 }, () => [
      Array.from({ length: 50 }, () => rand() % 7),
      Array.from({ length: 5 }, () => rand() % 7),
    ]),
    pairs = new Map<string, PairPacket>();
  for (let a = 0; a < 7; a++)
    for (let b = 0; b < 7; b++) {
      const rows: PairRow[] = [];
      docs.forEach((fields, doc) => {
        const lists = fields.map((tokens) =>
          tokens.flatMap((id, p) =>
            id === a && tokens[p + 1] === b
              ? [{ position: p, previous: tokens[p - 1], next: tokens[p + 2] }]
              : [],
          ),
        );
        if (lists.some((a) => a.length))
          rows.push({ doc, body: lists[0], title: lists[1] });
      });
      if (rows.length)
        pairs.set(`${a}:${b}`, new PairPacket(encodePairPacket(a, b, rows)));
    }
  for (let sample = 0; sample < 300; sample++) {
    const words = Array.from({ length: 2 + (rand() % 3) }, () => rand() % 7),
      anchor = words.length === 4 ? 1 : rand() % (words.length - 1),
      pair = pairs.get(`${words[anchor]}:${words[anchor + 1]}`);
    if (!pair) continue;
    const filter = intersectPairDocuments(
      words
        .slice(1)
        .map((b, i) => pairs.get(`${words[i]}:${b}`)!)
        .filter(Boolean),
    );
    docs.forEach((fields, doc) =>
      fields.forEach((tokens, field) => {
        const expected = tokens.flatMap((_, p) =>
            words.every((w, i) => tokens[p + i] === w) ? [p] : [],
          ),
          row = pair.docs.indexOf(doc),
          actual = row < 0 ? [] : pair.phrase(row, field, words, anchor).starts;
        expect([...actual], JSON.stringify({ words, doc, field })).toEqual(
          expected,
        );
        if (row >= 0)
          expect(pair.phrase(row, field, words, anchor).certain).toBe(true);
        if (expected.length) expect([...filter]).toContain(doc);
      }),
    );
  }
});
it("bounds sparse singleton and repeated two-field packet sizes even at full integer widths", () => {
  for (let mode = 0; mode < 12; mode++) {
    const rows: PairRow[] = Array.from({ length: 97 }, (_, doc) => {
      const field = (n: number) =>
        Array.from({ length: n }, (_, p) => ({
          position: p * 30000000,
          previous: 0xfffffffe - p,
          next: p * 40000000,
        }));
      return {
        doc: doc * 40000000,
        body: field(1 + (doc % (mode + 1))),
        title: field(doc % 3 === 0 ? mode : 0),
      };
    });
    const occurrences = rows.reduce(
      (n, r) => n + r.body.length + r.title.length,
      0,
    );
    expect(encodePairPacket(1, 2, rows).length).toBeLessThanOrEqual(
      pairPacketByteBound(rows.length, occurrences),
    );
  }
});
it("retains unknown long neighborhoods and rejects cross-field intersections and malformed packets", () => {
  const packet = new PairPacket(
    encodePairPacket(2, 3, [
      { doc: 1, body: [{ position: 2, previous: 1, next: 4 }], title: [] },
    ]),
  );
  const long = packet.phrase(0, 0, [0, 1, 2, 3, 4, 5], 2);
  expect(long.certain).toBe(false);
  expect([...long.starts]).toEqual([0]);
  expect(packet.phrase(0, 0, [0, 9, 2, 3, 4, 5], 2).certain).toBe(true);
  const other = new PairPacket(
    encodePairPacket(3, 4, [
      { doc: 1, body: [], title: [{ position: 0, next: 5 }] },
    ]),
  );
  expect([...intersectPairDocuments([packet, other])]).toEqual([]);
  expect(
    () => new PairPacket(packet.bytes.subarray(0, packet.bytes.length - 1)),
  ).toThrow();
  expect(() =>
    encodePairPacket(2, 3, [
      { doc: 1, body: [{ position: 0 }, { position: 0 }], title: [] },
    ]),
  ).toThrow();
});
