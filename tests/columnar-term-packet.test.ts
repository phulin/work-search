import { encodePositions } from "../src/columnar/positions.js";
import { scoreParameters } from "../src/columnar/scoring.js";
import { bm25 } from "../src/query/engine.js";
import { it, expect } from "vitest";
import {
  encodeTermPacket,
  decodeTermPacket,
  type PacketBlock,
} from "../src/columnar/term-packet.js";
import { encodeScores, concat, u32, pack } from "../src/columnar/format.js";
it("reads complete contiguous frequencies and independently verifies exact per-document positions and locators", () => {
  const stats = { count: 1000, avgBody: 1500, avgTitle: 5 },
    df = 263;
  const blocks: PacketBlock[] = [];
  const expected: {
    doc: number;
    b: number;
    t: number;
    body: number[];
    title: number[];
  }[] = [];
  for (let block = 0; block < 3; block++) {
    const docs: number[] = [],
      bf: number[] = [],
      tf: number[] = [],
      b: number[] = [],
      t: number[] = [],
      positions: { body: number[]; title: number[] }[] = [],
      bl: number[] = [],
      tl: number[] = [];
    for (let row = 0; row < (block === 2 ? 7 : 128); row++) {
      const doc = block * 256 + row * 2,
        body = [row, row + 9],
        title = row % 3 ? [1, 2] : [];
      docs.push(doc);
      bf.push(body.length);
      tf.push(title.length);
      bl.push(row + 25);
      tl.push(row + 5);
      b.push(bm25(body.length, df, stats.count, bl.at(-1)!, stats.avgBody));
      t.push(bm25(title.length, df, stats.count, tl.at(-1)!, stats.avgTitle));
      positions.push({ body, title });
      expected.push({ doc, b: b.at(-1)!, t: t.at(-1)!, body, title });
    }
    blocks.push({
      branch: {
        first: docs[0],
        last: docs.at(-1)!,
        count: docs.length,
        height: 0,
        b: Math.max(...b),
        t: Math.max(...t),
        score: [0, 0, 0],
        positions: [0, 0, 0],
        locators: [0, 0, 0],
      },
      scores: encodeScores(docs, bf, tf, bl, tl),
      positions: encodePositions(positions),
    });
  }
  const packet = encodeTermPacket(700, blocks),
    decoded = decodeTermPacket(
      packet.frequencies,
      700,
      [0, 0, 0],
      scoreParameters(df, stats),
    );
  expect([...decoded.docs]).toEqual(expected.map((r) => r.doc));
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    expect(decoded.b[i]).toBe(e.b);
    expect(decoded.t[i]).toBe(e.t);
    expect([...decoded.position(i, 0, packet.positional)]).toEqual(e.body);
    expect([...decoded.position(i, 1, packet.positional)]).toEqual(e.title);
    expect(decoded.locators.getUint32(i * 4, true)).toBe(e.doc);
  }
  expect(() =>
    decodeTermPacket(
      packet.frequencies,
      701,
      [0, 0, 0],
      scoreParameters(df, stats),
    ),
  ).toThrow();
  const bad = packet.positional.slice();
  bad[4] ^= 1;
  expect(() => decoded.position(1, 0, bad)).toThrow("positional");
});
