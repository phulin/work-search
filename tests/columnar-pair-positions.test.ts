import { expect, it } from "vitest";
import {
  enrichMembershipPositions,
  membershipAnchor,
} from "../src/columnar/membership-anchor.js";
import { Reader } from "../src/columnar/storage.js";
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
it("rejects expensive optional context before I/O and reads one covering pair instead of both", async () => {
  const docs = Uint32Array.of(0, 1, 2),
    generation = "c".repeat(64),
    payloads = [
      encodePairPacket(
        1,
        2,
        [...docs].map((doc) => ({
          doc,
          body: [{ position: 1, previous: 0, next: 3 }],
          title: [],
        })),
      ),
      encodePairPacket(
        2,
        3,
        [...docs].map((doc) => ({
          doc,
          body: [{ position: 2, previous: 1, next: 4 }],
          title: [],
        })),
      ),
    ],
    make = () => ({
      words: ["a", "b", "c"],
      absent: false,
      records: payloads.map(
        (p, i) =>
          new PairMembership(
            encodePairMembership(
              {
                a: i + 1,
                b: i + 2,
                df: docs.length,
                body: docs,
                title: new Uint32Array(),
                bodyOccurrences: docs.length,
                titleOccurrences: 0,
                context: encodePairPositionDirectory(i + 1, i + 2, generation, [
                  { first: 0, last: 2, object: i, offset: 0, length: p.length },
                ]),
              },
              docs.length,
            ),
            docs.length,
          ),
      ),
    }),
    ids = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]),
    reader = new Reader(
      { generation, objects: [] },
      {
        read: async () => {
          throw Error("Unnecessary postings");
        },
        readNamed: async (key, n) =>
          payloads[Number(/positions-(\d+)/.exec(key)![1])].subarray(0, n),
      },
    ),
    rejected = make();
  expect(
    await enrichMembershipPositions(
      rejected,
      docs,
      reader,
      1048576,
      false,
      10,
      ids,
    ),
  ).toBe(false);
  expect(reader.stats.requests).toBe(0);
  expect(reader.stats.pairPositionProductsSkipped).toBe(2);
  const selected = make();
  expect(
    await enrichMembershipPositions(
      selected,
      docs,
      reader,
      1048576,
      false,
      100,
      ids,
    ),
  ).toBe(true);
  expect(reader.stats.requests).toBe(1);
  const anchor = membershipAnchor(selected, ids, "all");
  expect(anchor.covered(selected.words)).toBe(true);
  for (const doc of docs)
    expect([...anchor.evidence(selected.words, doc, 0)!]).toEqual([1]);
});
it("joins nearby tiny context chunks while preserving exact candidate rows and bounding overfetch", async () => {
  const data: Uint8Array[] = [],
    chunks = [];
  let offset = 0;
  for (let doc = 0; doc < 4000; doc++) {
    const raw = encodePairPacket(1, 2, [
      { doc, body: [{ position: doc % 10, previous: 3, next: 4 }], title: [] },
    ]);
    chunks.push({
      first: doc,
      last: doc,
      object: 0,
      offset,
      length: raw.length,
    });
    data.push(raw);
    offset += raw.length;
  }
  const object = new Uint8Array(offset);
  let at = 0;
  for (const bytes of data) {
    object.set(bytes, at);
    at += bytes.length;
  }
  const directory = new PairPositionDirectory(
      encodePairPositionDirectory(1, 2, "a".repeat(64), chunks),
    ),
    docs = Uint32Array.from({ length: 2000 }, (_, i) => i * 2),
    reads: { offset: number; length: number }[] = [];
  const evidence = await readPairPositionChunks(
    directory,
    docs,
    async (key, n) => {
      const offset = Number(key.split("@")[1]);
      reads.push({ offset, length: n });
      return object.subarray(offset, offset + n);
    },
    object.length,
  );
  expect(reads.length).toBeLessThan(10);
  expect(reads.every((r) => r.length <= 262144)).toBe(true);
  expect(reads.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(
    2 * directory.selected(docs).reduce((n, c) => n + c.length, 0),
  );
  for (let row = 0; row < docs.length; row++) {
    expect(evidence!.count(row, 0)).toBe(1);
    expect([...evidence!.phrase(row, 0, [3, 1, 2, 4], 1).starts]).toEqual(
      [(docs[row] % 10) - 1].filter((p) => p >= 0),
    );
  }
});
it("skips scattered optional context when a complete pair read is cheaper", async () => {
  const count = 8192,
    docs = Uint32Array.from({ length: count }, (_, i) => i),
    chunks = [];
  let offset = 0;
  for (let start = 0; start < count; start += 128) {
    const bytes = encodePairPacket(
      1,
      2,
      Array.from({ length: 128 }, (_, i) => {
        const doc = start + i;
        return {
          doc,
          body: [{ position: doc, previous: doc * 997, next: doc * 991 }],
          title: [],
        };
      }),
    );
    expect(bytes.length).toBeGreaterThan(1024);
    chunks.push({
      first: start,
      last: start + 127,
      object: 0,
      offset,
      length: bytes.length,
    });
    offset += bytes.length;
  }
  const record = new PairMembership(
      encodePairMembership(
        {
          a: 1,
          b: 2,
          df: count,
          body: docs,
          title: new Uint32Array(),
          bodyOccurrences: count,
          titleOccurrences: 0,
          context: encodePairPositionDirectory(1, 2, "b".repeat(64), chunks),
        },
        count,
      ),
      count,
    ),
    selection = { words: ["a", "b", "c"], absent: false, records: [record] },
    candidates = Uint32Array.from({ length: 32 }, (_, i) => i * 256),
    reader = new Reader(
      { generation: "a".repeat(64), objects: [] },
      {
        read: async () => {
          throw Error("Optional context should not be read");
        },
        readNamed: async () => {
          throw Error("Optional context should not be read");
        },
      },
    );
  expect(
    await enrichMembershipPositions(
      selection,
      candidates,
      reader,
      offset,
      false,
      Infinity,
      new Map([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]),
    ),
  ).toBe(false);
  expect(reader.stats.requests).toBe(0);
  expect(reader.stats.pairPositionProductsSkipped).toBe(1);
  expect([...record.body.values()]).toEqual([...docs]);
});
