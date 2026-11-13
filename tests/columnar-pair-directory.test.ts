import { expect, it } from "vitest";
import {
  encodePairDirectory,
  PairDirectory,
  pairDirectoryShard,
} from "../src/columnar/pair-directory.js";
import { encodePairPacket } from "../src/columnar/pair-packet.js";
import { lookupRemotePairs } from "../src/columnar/pair-lookup.js";
import { readPairAnchor } from "../src/columnar/pair-execution.js";
import { Reader } from "../src/columnar/storage.js";
import { crc32 } from "../src/format/codec.js";
import type { Root, PositionalPair } from "../src/columnar/format.js";
import type { DirectoryTerm } from "../src/columnar/term-directory.js";
import { parse } from "../src/query/parser.js";
import type { PacketPlan } from "../src/columnar/packet-execution.js";
it("relocates inline complete pairs, preserves remote addresses and rejects corrupt/overlapping data", () => {
  const payload = encodePairPacket(1, 2, [
      { doc: 7, body: [{ position: 4, previous: 3, next: 4 }], title: [] },
    ]),
    a: PositionalPair = {
      a: 1,
      b: 2,
      df: 1,
      occurrences: 1,
      ref: [99, 50, payload.length],
    },
    b: PositionalPair = {
      a: 1,
      b: 0xffffffff,
      df: 3,
      occurrences: 8,
      ref: [100, 500, 123],
    },
    bytes = encodePairDirectory([{ pair: a, inline: payload }, { pair: b }]),
    address: [number, number, number] = [4, 8192, bytes.length],
    d = new PairDirectory(bytes, address);
  expect(d.lookup(1, 2)).toEqual({ ...a, ref: [4, 8192 + 96, payload.length] });
  expect(d.lookup(1, 0xffffffff)).toEqual(b);
  expect(d.lookup(1, 3)).toBeUndefined();
  const shard = {
    first: [1, 2] as [number, number],
    last: [1, 0xffffffff] as [number, number],
    ref: address,
  };
  expect(pairDirectoryShard([shard], 1, 2)).toBe(shard);
  expect(pairDirectoryShard([shard], 0, 99)).toBeUndefined();
  expect(pairDirectoryShard([shard], 2, 0)).toBeUndefined();
  expect(() => encodePairDirectory([{ pair: b }, { pair: a }])).toThrow();
  for (const offset of [0, 8, 12, 28, 44, 48, 52]) {
    const bad = bytes.slice();
    bad[offset] ^= 255;
    expect(() => new PairDirectory(bad, address)).toThrow();
  }
  expect(
    () => new PairDirectory(bytes.subarray(0, bytes.length - 1), address),
  ).toThrow();
});
it("finishes an inline phrase anchor after one physical lookup read, while absent and negative pairs remain unknown", async () => {
  const raw = encodePairPacket(1, 2, [
      { doc: 7, body: [{ position: 4, previous: 3, next: 4 }], title: [] },
    ]),
    pair: PositionalPair = {
      a: 1,
      b: 2,
      df: 1,
      occurrences: 1,
      ref: [0, 0, raw.length],
    },
    data = encodePairDirectory([{ pair, inline: raw }]),
    ref: [number, number, number] = [0, 0, data.length],
    root: Root = {
      format: "CWS1",
      generation: "a".repeat(64),
      corpusHash: "b".repeat(64),
      count: 20,
      avgBody: 10,
      avgTitle: 1,
      documents: [],
      dictionaries: [],
      hot: {},
      objects: [
        {
          name: "plan-0.bin",
          size: data.length,
          sha256: "c".repeat(64),
          checksums: [crc32(data)],
        },
      ],
      pairDirectory: {
        pairs: 1,
        shards: [{ first: [1, 2], last: [1, 2], ref }],
      },
    },
    terms = new Map([
      ...["alpha", "beta", "before", "after"].map(
        (word, i) =>
          [
            word,
            { id: i + 1, df: 20, bodyOccurrences: 100, titleOccurrences: 0 },
          ] as [string, DirectoryTerm],
      ),
    ]),
    plan: PacketPlan = {
      kind: "blocks",
      frequencyBytes: 1e7,
      positionBytes: 1e7,
      expectedCandidates: 20,
      expectedDocumentBytes: 1e7,
      gets: 20,
      dependentStages: 3,
    };
  let reads = 0;
  const reader = new Reader(root, {
      async read(_key, at, length) {
        reads++;
        return data.subarray(at, at + length);
      },
    }),
    ast = parse('"before alpha beta after"'),
    queryRoot = await lookupRemotePairs(ast, terms, root, reader, plan);
  expect(queryRoot.positionalPairs!["1:2"]).toBeDefined();
  expect(root.positionalPairs).toBeUndefined();
  const evidence = await readPairAnchor(
    [queryRoot.positionalPairs!["1:2"]],
    ["before", "alpha", "beta", "after"],
    new Map([...terms].map(([w, t]) => [w, t.id])),
    "body",
    reader,
  );
  expect([...evidence.candidates]).toEqual([7]);
  expect(reads).toBe(1);
  expect(reader.stats.pairDirectoryMatches).toBe(1);
  expect(
    await lookupRemotePairs(
      parse('NOT "alpha beta"'),
      terms,
      root,
      reader,
      plan,
    ),
  ).toBe(root);
  expect(
    await lookupRemotePairs(parse('"beta alpha"'), terms, root, reader, plan),
  ).toBe(root);
  expect(reads).toBe(1);
});
