import {
  planMembershipAnchor,
  intersectMembershipAnchor,
} from "../src/columnar/membership-anchor.js";
import { it, expect } from "vitest";
import {
  planBooleanMembership,
  readBooleanMembership,
  booleanMembershipAnchor,
} from "../src/columnar/boolean-membership.js";
import {
  encodePairMembership,
  encodePairMembershipPacket,
} from "../src/columnar/pair-membership.js";
import { PairRouter, encodePairRouter } from "../src/columnar/pair-router.js";
import { Reader } from "../src/columnar/storage.js";
import { parse } from "../src/query/parser.js";
import { u32 } from "../src/columnar/format.js";
const generation = "a".repeat(64),
  ids = new Map(["a", "b", "c", "d", "e", "f"].map((w, i) => [w, i]));
const entries = [
  { a: "a", b: "b", body: [0, 1, 4], title: [2] },
  { a: "c", b: "d", body: [0, 2, 5], title: [1] },
  { a: "e", b: "f", body: [3, 4], title: [5] },
];
function fixture(bytes?: number) {
  const packet = encodePairMembershipPacket(
    entries.map((e) => ({
      a: e.a,
      b: e.b,
      data: encodePairMembership(
        {
          a: ids.get(e.a)!,
          b: ids.get(e.b)!,
          df: new Set([...e.body, ...e.title]).size,
          body: Uint32Array.from(e.body),
          title: Uint32Array.from(e.title),
          bodyOccurrences: e.body.length,
          titleOccurrences: e.title.length,
        },
        64,
      ),
    })),
  );
  const router = new PairRouter(
    encodePairRouter(
      {
        generation,
        baseGeneration: generation,
        documents: 64,
        targetBytes: 131072,
        contextBytes: 0,
        namespaces: [],
        roots: [-1],
        commonWords: [],
      },
      [],
      [
        {
          namespace: 0,
          bits: 0,
          prefix: 0,
          bytes: bytes ?? packet.length,
          crc32: 0,
          pairs: entries.length,
        },
      ],
      encodePairMembershipPacket(
        entries.map((e) => ({
          a: e.a,
          b: e.b,
          data: u32([
            new Set([...e.body, ...e.title]).size,
            e.body.length,
            e.title.length,
            100,
            0,
          ]),
        })),
      ),
    ),
  );
  return {
    settings: { router, N: 0, M: 0 },
    reader: new Reader(
      { generation, objects: [] },
      {
        read: async () => {
          throw Error("unexpected score read");
        },
        readNamed: async () => packet,
      },
    ),
  };
}
const alternative = {
  kind: "blocks" as const,
  frequencyBytes: 32 * 1048576,
  positionBytes: 2048 * 1048576,
  expectedCandidates: 64,
};
async function candidates(q: string, field: "all" | "body" | "title" = "all") {
  const { settings, reader } = fixture(),
    plan = planBooleanMembership(
      parse(q),
      settings,
      undefined,
      16384,
      field,
      alternative,
    );
  if (!plan) return;
  const a = booleanMembershipAnchor(
    await readBooleanMembership(plan, reader, settings),
    ids,
    field,
  );
  const docs = [...a.values()];
  expect(docs).toHaveLength(a.count);
  for (let d = 0; d < 8; d++) expect(a.has(d)).toBe(docs.includes(d));
  return docs;
}
it("intersects evidence with unions across Boolean branches before any score reads", async () => {
  expect(await candidates('"a b" AND ("c d" OR "e f")')).toEqual([0, 1, 2, 4]);
  expect(await candidates('("a b" OR "c d") AND "e f"')).toEqual([4, 5]);
  expect(await candidates('"a b" AND ("c d" OR "e f")', "body")).toEqual([
    0, 4,
  ]);
  expect(await candidates('"a b" AND ("c d" OR "e f")', "title")).toEqual([]);
});
it("reuses the exact sorted intersection with necessary unigrams for both continuation paths", async () => {
  const { settings, reader } = fixture(),
    ast = parse('"a b" AND ("c d" OR "e f")'),
    plan = planBooleanMembership(
      ast,
      settings,
      undefined,
      16384,
      "all",
      alternative,
    )!,
    original = booleanMembershipAnchor(
      await readBooleanMembership(plan, reader, settings),
      ids,
      "all",
    ),
    selected = intersectMembershipAnchor(original, Uint32Array.of(1, 3, 4));
  expect(selected.count).toBe(2);
  expect([...selected.values()]).toEqual([1, 4]);
  const cursor = selected.cursor();
  expect([cursor.next(), cursor.next(), cursor.next()]).toEqual([
    1,
    4,
    Infinity,
  ]);
  expect([0, 1, 2, 3, 4, 5].filter((d) => selected.has(d))).toEqual([1, 4]);
  expect(selected.evidence).toBe(original.evidence);
  expect(selected.covered).toBe(original.covered);
  expect(intersectMembershipAnchor(original, new Uint32Array()).count).toBe(0);
});
it("only skips common-word filters proved on every surviving OR branch", () => {
  const { settings } = fixture();
  const plan = planBooleanMembership(
    parse('"a b" AND ("c d" OR "e f")'),
    settings,
    undefined,
    16384,
    "all",
    alternative,
  );
  expect([...plan!.provedWords].sort()).toEqual(["a", "b"]);
});
it("keeps unknown OR branches and negative supersets conservative", async () => {
  expect(await candidates('"a b" OR unknown')).toBeUndefined();
  expect(await candidates('"a b" AND ("c d" OR unknown)')).toEqual([
    0, 1, 2, 4,
  ]);
  expect(await candidates('"a b" NOT "c d"')).toEqual([0, 1, 2, 4]);
  expect(await candidates('NOT "a b"')).toBeUndefined();
  expect(await candidates('NOT NOT "a b"')).toBeUndefined();
  expect(await candidates('"a b" AND ("c d" OR "missing pair")')).toEqual([
    0, 1, 2,
  ]);
});
it("preserves independent Boolean fields and requires same-field proximity evidence", async () => {
  expect(await candidates('"a b" AND "c d"')).toEqual([0, 1, 2]);
  expect(await candidates('"a b" /75 "c d"')).toEqual([0]);
  expect(await candidates('"a b" /75 ("c d" OR "e f")')).toEqual([0, 4]);
});
it("treats absent authoritative records as empty and bounds multi-branch reads safely", async () => {
  expect(await candidates('"missing pair" OR "a b"')).toEqual([0, 1, 2, 4]);
  expect(await candidates('"missing pair" AND "a b"')).toEqual([]);
  const { settings } = fixture(9 * 1048576);
  expect(
    planBooleanMembership(
      parse('"a b" OR "c d"'),
      settings,
      undefined,
      16384,
      "all",
      { ...alternative, frequencyBytes: 128 * 1048576 },
    ),
  ).toBeUndefined();
});

it("preserves the existing plan for standalone phrases", () => {
  const { settings } = fixture();
  for (const q of ['"a b"', '"c d"', '"missing pair"']) {
    const ast = parse(q);
    const old = planMembershipAnchor(
      ast,
      settings,
      undefined,
      16384,
      "all",
      alternative,
    );
    const plan = planBooleanMembership(
      ast,
      settings,
      undefined,
      16384,
      "all",
      alternative,
    );
    expect(plan?.plans).toEqual(old ? [old] : undefined);
  }
});
