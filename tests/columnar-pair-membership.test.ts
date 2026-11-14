import { expect, it, vi } from "vitest";
import {
  Membership,
  PairMembershipPacket,
  encodeMembership,
  encodePairMembership,
  encodePairMembershipPacket,
  pairStringHash,
  pairHash,
} from "../src/columnar/pair-membership.js";
import {
  PairRouter,
  encodePairRouter,
  NO_PAIR_PARTITION,
} from "../src/columnar/pair-router.js";
import { encodePairPacket } from "../src/columnar/pair-packet.js";
import { crc32 } from "../src/format/codec.js";
import { Reader } from "../src/columnar/storage.js";
import {
  lookupMembershipAnchor,
  membershipAnchor,
  planMembershipAnchor,
  planCommonPresence,
} from "../src/columnar/membership-anchor.js";
import { parse } from "../src/query/parser.js";
import { pairObjectKey } from "../src/columnar/pair-router.js";
import { u32 } from "../src/columnar/format.js";
it("prices saved candidate request waves even when numeric verification records are small", () => {
  const router = new PairRouter(
      encodePairRouter(
        {
          generation: "a".repeat(64),
          baseGeneration: "b".repeat(64),
          documents: 1000000,
          targetBytes: 131072,
          contextBytes: 0,
          namespaces: [],
          roots: [-1],
          commonWords: [],
        },
        [],
        [
          {
            object: 0,
            offset: 0,
            bytes: 45582,
            pairs: 100,
            namespace: 0,
            bits: 0,
            prefix: 0,
            crc32: 0,
          },
        ],
        encodePairMembershipPacket([]),
      ),
    ),
    alternative = {
      kind: "documents" as const,
      frequencyBytes: 297204,
      positionBytes: 0,
      expectedCandidates: 416,
      anchors: ["rare"],
    },
    choice = planMembershipAnchor(
      parse('"rare phrase"'),
      { router, N: 100, M: 1000 },
      new Map([
        ["rare", { df: 64280 }],
        ["phrase", { df: 900000 }],
      ]),
      4849,
      "all",
      alternative,
    );
  expect(choice).toBeDefined();
  expect(choice!.savedWork).toBeGreaterThan(choice!.readWork);
  expect(
    planMembershipAnchor(
      parse('"rare phrase"'),
      { router, N: 100, M: 1000 },
      new Map([
        ["rare", { df: 64280 }],
        ["phrase", { df: 900000 }],
      ]),
      4849,
      "all",
      { ...alternative, expectedCandidates: 1 },
    ),
  ).toBeUndefined();
});
it("compares optional membership work with the existing plan before reading, retaining sparse all-common anchors", () => {
  const router = new PairRouter(
      encodePairRouter(
        {
          generation: "f".repeat(64),
          baseGeneration: "b".repeat(64),
          documents: 1000000,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [-1],
          commonWords: [
            { word: "of", id: 1, df: 918416 },
            { word: "the", id: 2, df: 899105 },
            { word: "and", id: 3, df: 878577 },
            { word: "an", id: 4, df: 703385 },
          ],
        },
        [],
        [
          {
            object: 0,
            offset: 0,
            namespace: 0,
            bits: 0,
            prefix: 0,
            bytes: 131072,
            crc32: 1,
            pairs: 100,
          },
        ],
        encodePairMembershipPacket([
          { a: "burden", b: "of", data: u32([106450, 106450, 1, 101788, 553]) },
          { a: "ranked", b: "tail", data: u32([44593, 44593, 0, 45000, 2000]) },
          { a: "the", b: "an", data: u32([304, 304, 0, 700, 0]) },
          { a: "an", b: "of", data: u32([216, 215, 1, 504, 0]) },
          { a: "the", b: "absence", data: u32([44593, 44593, 0, 1000, 10]) },
        ]),
      ),
    ),
    settings = { router, N: 100, M: 1000 },
    words = new Map([
      ["burden", { df: 155090 }],
      ["of", { df: 918416 }],
      ["prove", { df: 188056 }],
      ["the", { df: 899105 }],
      ["an", { df: 703385 }],
      ["absence", { df: 155090 }],
    ]),
    base = {
      kind: "blocks" as const,
      frequencyBytes: 28207300,
      positionBytes: 98301112,
      expectedCandidates: 155090,
    };
  expect(
    planMembershipAnchor(
      parse('"burden of prove"'),
      settings,
      words,
      20000,
      "body",
      base,
    ),
  ).toBeUndefined();
  // Every pair is top-M, but the phrase contains an ordinary word. The old
  // eligibility gate rejected it without comparing the available alternatives.
  expect(
    planMembershipAnchor(
      parse('"the absence"'),
      settings,
      words,
      20000,
      "all",
      { ...base, positionBytes: 2048 * 1048576 },
    )?.pairs.map((p) => [p.a, p.b]),
  ).toEqual([["the", "absence"]]);
  // Corpus-wide pair DF exceeds the existing unigram intersection. It can still
  // substantially reduce that intersection when conditioned on a shared word.
  expect(
    planMembershipAnchor(
      parse('"the absence"'),
      settings,
      words,
      200000,
      "all",
      {
        ...base,
        kind: "documents",
        expectedCandidates: 50,
        anchors: ["absence"],
      },
    )?.pairs,
  ).toHaveLength(1);
  expect(
    planMembershipAnchor(parse('"the an of"'), settings, words, 20000, "all", {
      ...base,
      frequencyBytes: 56356668,
      positionBytes: 252913700,
      expectedCandidates: 703385,
    })?.pairs.length,
  ).toBeGreaterThan(0);
  expect(
    planMembershipAnchor(parse('"the an of"'), settings, words, 20000, "all", {
      ...base,
      kind: "complete-terms",
      frequencyBytes: 1000,
      positionBytes: 1000,
    }),
  ).toBeUndefined();
});
it("skips presence already proved by a pair and presence that cannot repay its read", () => {
  const router = new PairRouter(
      encodePairRouter(
        {
          generation: "f".repeat(64),
          baseGeneration: "b".repeat(64),
          documents: 1000000,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [NO_PAIR_PARTITION],
          commonWords: [{ word: "common", id: 1, df: 100000 }],
        },
        [],
        [],
        encodePairMembershipPacket([]),
      ),
    ),
    settings = {
      router,
      N: 100,
      M: 1000,
      presence: {
        generation: router.metadata.generation,
        entries: [{ bytes: 100000, crc32: 1 }],
      },
    },
    required = new Set(["common", "selective"]),
    base = {
      kind: "documents" as const,
      frequencyBytes: 1000,
      positionBytes: 0,
      expectedCandidates: 100,
    };
  expect(
    planCommonPresence(required, settings, new Set(), base, 20000, false),
  ).toEqual([0]);
  expect(
    planCommonPresence(
      required,
      settings,
      new Set(["common"]),
      base,
      20000,
      false,
    ),
  ).toEqual([]);
  expect(
    planCommonPresence(
      required,
      settings,
      new Set(),
      { ...base, kind: "complete-terms" },
      20000,
      false,
    ),
  ).toEqual([]);
});

it("preserves exact membership at every density using only sorted restartable lists", () => {
  for (const docs of [
    new Uint32Array(),
    Uint32Array.of(5),
    Uint32Array.from({ length: 10000 }, (_, i) => i),
    Uint32Array.from({ length: 513 }, (_, i) => i * 17),
  ]) {
    const encoded = encodeMembership(docs, 10000),
      m = new Membership(encoded.data, encoded.mode, docs.length, 10000),
      reference = new Set(docs);
    expect(encoded.mode).toBeLessThanOrEqual(2);
    for (let doc = 0; doc < 10000; doc++)
      expect(m.has(doc)).toBe(reference.has(doc));
    expect([...m.values()]).toEqual([...docs]);
  }
});
it("keeps exact pair identity and field boundaries and decodes only the requested record", () => {
  const context = encodePairPacket(1, 2, [
    { doc: 3, body: [{ position: 2, previous: 0, next: 4 }], title: [] },
  ]);
  const data = encodePairMembership(
      {
        a: 1,
        b: 2,
        df: 1,
        body: Uint32Array.of(3),
        title: new Uint32Array(),
        bodyOccurrences: 1,
        titleOccurrences: 0,
        context,
      },
      20,
    ),
    packet = new PairMembershipPacket(
      encodePairMembershipPacket([
        { a: "the", b: "absence", data },
        { a: "invalid", b: "neighbor", data: Uint8Array.of(255) },
      ]),
    );
  const pair = packet.lookup("the", "absence", 20)!;
  expect([...pair.documents("all")]).toEqual([3]);
  expect(pair.has(3, "title")).toBe(false);
  expect(pair.context!.phrase(0, 0, [0, 1, 2, 4], 1)).toEqual({
    certain: true,
    starts: Uint32Array.of(1),
  });
  expect(packet.lookup("the", "absent", 20)).toBeUndefined();
  expect(() => packet.lookup("invalid", "neighbor", 20)).toThrow();
});
it("uses exact counts and one numeric pass for a single membership without context", () => {
  const docs = Uint32Array.from({ length: 10000 }, (_, i) => i * 2),
    decoded = vi.fn(),
    record = new PairMembershipPacket(
      encodePairMembershipPacket([
        {
          a: "a",
          b: "b",
          data: encodePairMembership(
            {
              a: 1,
              b: 2,
              df: docs.length,
              body: docs,
              title: new Uint32Array(),
              bodyOccurrences: docs.length,
              titleOccurrences: 0,
            },
            20000,
          ),
        },
      ]),
    ).lookup("a", "b", 20000, undefined, decoded)!,
    anchor = membershipAnchor(
      { words: ["a", "b"], records: [record], absent: false },
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
      "all",
    );
  expect(anchor.count).toBe(docs.length);
  expect(decoded).not.toHaveBeenCalled();
  expect([...anchor.values()]).toEqual([...docs]);
  expect(decoded).toHaveBeenCalledTimes(Math.ceil(docs.length / 128));
});
it("rejects a mandatory phrase from bundled field counts even when its pair is excluded", async () => {
  const generation = "f".repeat(64),
    router = new PairRouter(
      encodePairRouter(
        {
          generation,
          baseGeneration: generation,
          documents: 20,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [NO_PAIR_PARTITION],
          commonWords: [],
        },
        [],
        [],
        encodePairMembershipPacket([
          { a: "alpha", b: "beta", data: u32([3, 3, 0, 100, 1]) },
        ]),
      ),
    ),
    read = vi.fn(async () => {
      throw Error("Unexpected remote read");
    }),
    reader = new Reader({ generation, objects: [] }, { read, readNamed: read }),
    settings = { router, N: 100, M: 1000 };
  expect(
    await lookupMembershipAnchor(
      parse('"alpha beta"'),
      reader,
      settings,
      undefined,
      undefined,
      "title",
    ),
  ).toEqual({ words: ["alpha", "beta"], records: [], absent: true });
  expect(
    await lookupMembershipAnchor(
      parse('"alpha beta" OR gamma'),
      reader,
      settings,
      undefined,
      undefined,
      "title",
    ),
  ).toBeUndefined();
  expect(
    await lookupMembershipAnchor(
      parse('gamma NOT "alpha beta"'),
      reader,
      settings,
      undefined,
      undefined,
      "title",
    ),
  ).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
it("routes normalized strings without any term-ID lookup and treats an empty partition as absent", () => {
  const hash = pairHash(pairStringHash("rare"), pairStringHash("word")),
    bit = hash >>> 31,
    leaf = {
      object: 0,
      offset: 0,
      namespace: 0,
      bits: 1,
      prefix: bit,
      bytes: 200,
      crc32: crc32(Uint8Array.of(1)),
      pairs: 1,
    },
    nodes: [number, number][] = [[NO_PAIR_PARTITION, NO_PAIR_PARTITION]];
  nodes[0][bit] = -1;
  const router = new PairRouter(
    encodePairRouter(
      {
        generation: "g",
        baseGeneration: "b",
        documents: 20,
        targetBytes: 131072,
        contextBytes: 8192,
        namespaces: [],
        roots: [0],
        commonWords: [],
      },
      nodes,
      [leaf],
      encodePairMembershipPacket([]),
    ),
  );
  expect(router.route("rare", "word")).toEqual({
    ...leaf,
    suffix: 0,
    crc32: 0,
  });
  const absent = Array.from({ length: 100 }, (_, i) => String(i)).find(
    (s) => pairHash(pairStringHash(s), pairStringHash("word")) >>> 31 !== bit,
  )!;
  expect(router.route(absent, "word")).toBeUndefined();
});
it("uses the secondary hash when the primary prefix is exhausted", () => {
  const a = "collision",
    b = "successor",
    h = pairHash(pairStringHash(a), pairStringHash(b)),
    h2 = pairHash(pairStringHash("!" + a), pairStringHash("!" + b)),
    nodes: [number, number][] = Array.from({ length: 33 }, () => [
      NO_PAIR_PARTITION,
      NO_PAIR_PARTITION,
    ]);
  for (let depth = 0; depth < 33; depth++)
    nodes[depth][
      ((depth < 32 ? h : h2) >>> (depth < 32 ? 31 - depth : 63 - depth)) & 1
    ] = depth === 32 ? -1 : depth + 1;
  const leaf = {
      object: 0,
      offset: 0,
      namespace: 0,
      bits: 33,
      prefix: h,
      suffix: h2 >>> 31,
      bytes: 131073,
      crc32: 1,
      pairs: 1,
    },
    router = new PairRouter(
      encodePairRouter(
        {
          generation: "g",
          baseGeneration: "b",
          documents: 1000000,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [0],
          commonWords: [],
        },
        nodes,
        [leaf],
        encodePairMembershipPacket([]),
      ),
    );
  expect(router.route(a, b)).toEqual({ ...leaf, crc32: 0 });
});
it("starts two unknown memberships together and rejects cross-field intersections", async () => {
  const a = "alpha",
    b = "beta",
    c = Array.from({ length: 100 }, (_, i) => "word" + i).find(
      (c) =>
        pairHash(pairStringHash(a), pairStringHash(b)) >>> 31 !==
        pairHash(pairStringHash(b), pairStringHash(c)) >>> 31,
    )!,
    generation = "f".repeat(64),
    nodes: [number, number][] = [[NO_PAIR_PARTITION, NO_PAIR_PARTITION]],
    leaves = [],
    objects = new Map<string, Uint8Array>();
  for (const [first, second, field, id] of [
    [a, b, "body", 1],
    [b, c, "title", 2],
  ] as const) {
    const raw = encodePairMembership(
        {
          a: id,
          b: id + 1,
          df: 1,
          body: field === "body" ? Uint32Array.of(3) : new Uint32Array(),
          title: field === "title" ? Uint32Array.of(3) : new Uint32Array(),
          bodyOccurrences: field === "body" ? 1 : 0,
          titleOccurrences: field === "title" ? 1 : 0,
        },
        20,
      ),
      packet = encodePairMembershipPacket([{ a: first, b: second, data: raw }]),
      prefix = pairHash(pairStringHash(first), pairStringHash(second)) >>> 31,
      leaf = {
        object: 0,
        offset: 0,
        namespace: 0,
        bits: 1,
        prefix,
        bytes: packet.length,
        crc32: crc32(packet),
        pairs: 1,
      };
    nodes[0][prefix] = -leaves.length - 1;
    leaf.object = leaves.length;
    leaves.push(leaf);
    objects.set(pairObjectKey(generation, leaf), packet);
  }
  const router = new PairRouter(
    encodePairRouter(
      {
        generation,
        baseGeneration: generation,
        documents: 20,
        targetBytes: 131072,
        contextBytes: 8192,
        namespaces: [],
        roots: [0],
        commonWords: [],
      },
      nodes,
      leaves,
      encodePairMembershipPacket([]),
    ),
  );
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    started: string[] = [];
  const reader = new Reader(
      { generation, objects: [] },
      {
        read: async () => {
          throw Error("No term-ID discovery permitted");
        },
        readNamed: async (key) => {
          started.push(key);
          await barrier;
          return objects.get(key)!;
        },
      },
    ),
    pending = lookupMembershipAnchor(parse(`"${a} ${b} ${c}"`), reader, {
      router,
      N: 0,
      M: 0,
    });
  await vi.waitFor(() => expect(started).toHaveLength(2));
  release();
  const selection = (await pending)!;
  expect(selection.absent).toBe(false);
  expect(selection.records).toHaveLength(2);
  expect(
    membershipAnchor(
      selection,
      new Map([
        [a, 1],
        [b, 2],
        [c, 3],
      ]),
      "all",
    ).count,
  ).toBe(0);
});
