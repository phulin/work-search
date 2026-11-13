import { it, expect } from "vitest";
import {
  encodeTermPacket,
  decodeTermPacket,
  type PacketBlock,
} from "../src/columnar/term-packet.js";
import { encodeScores, concat, u32, pack } from "../src/columnar/format.js";
it("reads complete contiguous frequencies and independently verifies exact per-document positions and locators", () => {
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
      positions: Uint8Array[] = [],
      offsets = [0];
    for (let row = 0; row < (block === 2 ? 7 : 128); row++) {
      const doc = block * 256 + row * 2,
        body = [row, row + 9],
        title = row % 3 ? [1, 2] : [];
      docs.push(doc);
      bf.push(body.length);
      tf.push(title.length);
      b.push(Math.PI + row / 17);
      t.push(Math.E * title.length);
      const bp = pack(body, true),
        tp = pack(title, true),
        raw = concat([u32([bp.length]), bp, tp]);
      positions.push(raw);
      offsets.push(offsets.at(-1)! + raw.length);
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
      scores: encodeScores(docs, bf, tf, b, t),
      positions: concat([u32([docs.length]), u32(offsets), ...positions]),
    });
  }
  const packet = encodeTermPacket(700, blocks),
    decoded = decodeTermPacket(packet.frequencies, 700);
  expect([...decoded.docs]).toEqual(expected.map((r) => r.doc));
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    expect(decoded.b[i]).toBe(e.b);
    expect(decoded.t[i]).toBe(e.t);
    expect([...decoded.position(i, 0, packet.positional)]).toEqual(e.body);
    expect([...decoded.position(i, 1, packet.positional)]).toEqual(e.title);
    expect(decoded.locators.getUint32(i * 4, true)).toBe(e.doc);
  }
  expect(() => decodeTermPacket(packet.frequencies, 701)).toThrow();
  const bad = packet.positional.slice();
  bad[4] ^= 1;
  expect(() => decoded.position(1, 0, bad)).toThrow("positional");
});
