import { expect, it } from "vitest";
import {
  encodeRankingHeads,
  decodeRankingHeads,
} from "../src/suffix/ranking-heads.js";
import { canonicalBit, type SuffixBlock } from "../src/suffix/format.js";

it("keeps the best canonical rows and a conservative bound for every omitted row, including ties and short tails", () => {
  let seed = 71;
  const random = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32,
    blocks: SuffixBlock[] = [];
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const count = i < 4 ? i + 1 : Math.floor(random() * 4096) + 1,
      columns = {} as SuffixBlock["columns"];
    for (const name of [
      "documents",
      "positions",
      "flags",
      ...Array.from({ length: 4 }, (_, i) => `score16-${i + 2}`),
      ...Array.from({ length: 4 }, (_, i) => `score8-${i + 2}`),
    ])
      columns[name as keyof typeof columns] = {
        offset: total * 100 + 2 ** 33,
        length: count * 4,
      };
    blocks.push({
      first: total,
      count,
      low: [],
      high: [],
      columns,
      scoreMaximum: [10, 20, 30, 40],
      minDocument: 0,
    });
    total += count;
  }
  const docs = Uint32Array.from({ length: total }, () =>
      Math.floor(random() * 1000000),
    ),
    positions = Uint32Array.from({ length: total }, () =>
      Math.floor(random() * 2 ** 32),
    ),
    flags = Uint16Array.from({ length: total }, () =>
      Math.floor(random() * 4096),
    ),
    scores = Array.from({ length: 4 }, () =>
      Uint16Array.from(
        { length: total },
        () => Math.floor(random() * 64) * 1024,
      ),
    ),
    packets = encodeRankingHeads(blocks, docs, positions, flags, scores);
  for (let p = 0; p < 4; p++) {
    const decoded = decodeRankingHeads(packets[p], p + 2, 0, total);
    expect(decoded).toHaveLength(blocks.length);
    for (const [i, head] of decoded.entries()) {
      const b = blocks[i],
        rows = Array.from({ length: b.count }, (_, j) => j)
          .filter((j) => flags[b.first + j] & canonicalBit(p + 2, "all"))
          .sort(
            (a, c) =>
              scores[p][b.first + c] - scores[p][b.first + a] ||
              docs[b.first + a] - docs[b.first + c] ||
              a - c,
          ),
        selected = rows.slice(0, 32),
        rest = rows.slice(32);
      expect([...head.rows]).toEqual(selected);
      expect([...head.docs]).toEqual(selected.map((j) => docs[b.first + j]));
      expect([...head.positions]).toEqual(
        selected.map((j) => positions[b.first + j]),
      );
      expect(head.remainder).toBe(
        Math.max(0, ...rest.map((j) => scores[p][b.first + j])),
      );
      expect(head.complete).toBe(rest.length === 0);
      expect(head.block.columns.documents).toEqual(b.columns.documents);
      expect(head.block.scoreMaximum[p]).toBe(b.scoreMaximum[p]);
    }
    expect(() =>
      decodeRankingHeads(
        packets[p].subarray(0, packets[p].length - 1),
        p + 2,
        0,
        total,
      ),
    ).toThrow();
    expect(() => decodeRankingHeads(packets[p], p + 2, 0, total + 1)).toThrow();
  }
});
