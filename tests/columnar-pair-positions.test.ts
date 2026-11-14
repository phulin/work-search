import { expect, it } from "vitest";
import {
  pairPositionChunks,
  encodePairPositionDirectory,
  PairPositionDirectory,
  readPairPositionChunks,
} from "../src/columnar/pair-positions.js";
import {
  encodePairPacket,
  PairPacket,
  type PairRow,
} from "../src/columnar/pair-packet.js";
import {
  PairMembership,
  encodePairMembership,
} from "../src/columnar/pair-membership.js";
it("keeps complete pair membership small and independently fetches exact context chunks, including split long documents", async () => {
  const rows: PairRow[] = Array.from({ length: 600 }, (_, doc) => ({
      doc,
      body: Array.from({ length: doc === 128 ? 20000 : 3 }, (_, i) => ({
        position: i * 4 + 1,
        previous: 0,
        next: 3,
      })),
      title: [{ position: 1, previous: 0, next: 3 }],
    })),
    columns = rows.map((r) => ({
      doc: r.doc,
      body: {
        positions: r.body.map((p) => p.position),
        previous: r.body.map((p) => p.previous! + 1),
        next: r.body.map((p) => p.next! + 1),
      },
      title: {
        positions: r.title.map((p) => p.position),
        previous: r.title.map((p) => p.previous! + 1),
        next: r.title.map((p) => p.next! + 1),
      },
    })),
    full = new PairPacket(encodePairPacket(1, 2, rows)),
    generation = "b".repeat(64);
  for (const budget of [16384, 32768, 65536]) {
    const chunks = [...pairPositionChunks(1, 2, columns, budget)];
    expect(chunks.every((c) => c.data.length <= budget)).toBe(true);
    expect(chunks.filter((c) => c.first === 128).length).toBeGreaterThan(1);
    const directory = encodePairPositionDirectory(
        1,
        2,
        generation,
        chunks.map((c, i) => ({
          ...c,
          object: i,
          offset: 0,
          length: c.data.length,
        })),
      ),
      members = encodePairMembership(
        {
          a: 1,
          b: 2,
          df: rows.length,
          body: Uint32Array.from(rows, (r) => r.doc),
          title: Uint32Array.from(rows, (r) => r.doc),
          bodyOccurrences: rows.reduce((n, r) => n + r.body.length, 0),
          titleOccurrences: rows.length,
          context: directory,
        },
        rows.length,
      ),
      record = new PairMembership(members, rows.length),
      docs = Uint32Array.of(0, 128, rows.length - 1),
      read: number[] = [];
    expect(record.context).toBeUndefined();
    expect(record.positionDirectory).toBeDefined();
    const fetch = async (address: string) => {
        const i = Number(/positions-(\d+)/.exec(address)![1]);
        read.push(i);
        return chunks[i].data;
      },
      evidence = (await readPairPositionChunks(
        record.positionDirectory!,
        docs,
        fetch,
        32 * 1048576,
      ))!;
    expect(read.length).toBeLessThan(chunks.length);
    for (let row = 0; row < docs.length; row++)
      for (const field of [0, 1]) {
        expect(evidence.count(row, field)).toBe(full.count(docs[row], field));
        for (const words of [
          [1, 2],
          [0, 1, 2],
          [1, 2, 3],
          [0, 1, 2, 3],
        ])
          expect(
            evidence.phrase(row, field, words, words[0] === 0 ? 1 : 0).starts,
          ).toEqual(
            full.phrase(docs[row], field, words, words[0] === 0 ? 1 : 0).starts,
          );
      }
    read.length = 0;
    expect(
      await readPairPositionChunks(
        new PairPositionDirectory(directory),
        docs,
        fetch,
        1,
      ),
    ).toBeUndefined();
    expect(read).toEqual([]);
  }
});
