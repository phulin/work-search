import { it, expect } from "vitest";
import {
  encodePairPacket,
  PairPacket,
  type PairRow,
} from "../src/columnar/pair-packet.js";
import { pairPhraseEvidence, pairKey } from "../src/columnar/pair-evidence.js";
import { positionalMatcher } from "../src/query/evaluate.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import type { DecodedPostings } from "../src/format/codec.js";

it("combines pair context into exact long spans and preserves unknown uncovered neighborhoods", () => {
  const ids = new Map(
      Array.from({ length: 8 }, (_, i) => [String.fromCharCode(97 + i), i]),
    ),
    a = new PairPacket(
      encodePairPacket(1, 2, [
        { doc: 0, body: [{ position: 1, previous: 0, next: 3 }], title: [] },
      ]),
    ),
    b = new PairPacket(
      encodePairPacket(4, 5, [
        { doc: 0, body: [{ position: 4, previous: 3, next: 6 }], title: [] },
      ]),
    ),
    names = [...ids.keys()].slice(0, 7),
    packets = new Map([[pairKey(1, 2), a]]);
  expect(pairPhraseEvidence(packets, ids)(names, 0, 0)).toBeUndefined();
  packets.set(pairKey(4, 5), b);
  expect([...pairPhraseEvidence(packets, ids)(names, 0, 0)!]).toEqual([0]);
  expect([...pairPhraseEvidence(packets, ids)(names, 0, 1)!]).toEqual([]);
  expect([...pairPhraseEvidence(packets, ids)(names, 1, 0)!]).toEqual([]);
  expect(pairPhraseEvidence(new Map(), ids)(names, 0, 0)).toBeUndefined();
});

it("uses exact pair evidence underneath Boolean negation and proximity without reading word positions when proof suffices", () => {
  const docs = [
      [[0, 1, 2, 3, 4, 0, 1, 2], []],
      [
        [0, 1, 2, 4],
        [3, 0, 1, 2],
      ],
      [
        [1, 1, 1, 2],
        [0, 1],
      ],
      [[0, 4, 1, 2], []],
    ],
    ids = new Map([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
      ["e", 4],
    ]),
    packets = new Map<string, PairPacket>();
  for (const [a, b] of [
    [0, 1],
    [1, 2],
    [1, 1],
    [2, 3],
  ]) {
    const rows: PairRow[] = [];
    docs.forEach((fields, doc) => {
      const occurrences = fields.map((tokens) =>
        tokens.flatMap((t, p) =>
          t === a && tokens[p + 1] === b
            ? [{ position: p, previous: tokens[p - 1], next: tokens[p + 2] }]
            : [],
        ),
      );
      if (occurrences.some((a) => a.length))
        rows.push({ doc, body: occurrences[0], title: occurrences[1] });
    });
    packets.set(pairKey(a, b), new PairPacket(encodePairPacket(a, b, rows)));
  }
  for (const q of [
    '"a b c"',
    'NOT "a b c"',
    '"a b c" OR "b b c"',
    '"a b c" /2 e',
    'NOT NOT "a b c"',
    '"a b c d" /1 a',
    'a NOT "a b c"',
    '"a b c d e a b c"',
  ])
    for (const field of ["all", "body", "title"] as const) {
      const ast = parse(q),
        lists = new Map<string, DecodedPostings>(),
        evidence = pairPhraseEvidence(packets, ids);
      for (const name of queryTerms(ast)) {
        const id = ids.get(name)!,
          rows = docs.flatMap((fields, doc) =>
            fields.some((a) => a.includes(id)) ? [doc] : [],
          );
        lists.set(name, {
          docs: Uint32Array.from(rows),
          body: Uint32Array.from(
            rows.map((doc) => docs[doc][0].filter((t) => t === id).length),
          ),
          title: Uint32Array.from(
            rows.map((doc) => docs[doc][1].filter((t) => t === id).length),
          ),
          bytes: new Uint8Array(),
        });
      }
      const match = positionalMatcher(
        ast,
        lists,
        field,
        (name, doc, f) =>
          Uint32Array.from(
            docs[doc][f].flatMap((id, p) => (id === ids.get(name) ? [p] : [])),
          ),
        {},
        evidence,
      );
      docs.forEach((fields, doc) =>
        expect(match(doc), q + field + doc).toBe(
          exhaustive(
            ast,
            (field === "all" ? fields : [fields[field === "body" ? 0 : 1]]).map(
              (tokens) => tokens.map((id) => String.fromCharCode(97 + id)),
            ),
          ),
        ),
      );
    }
  const ast = parse('NOT "a b c"'),
    names = (ast as any).child.terms,
    evidence = pairPhraseEvidence(packets, ids),
    match = positionalMatcher(
      ast,
      new Map(),
      "body",
      () => {
        throw Error("unnecessary position read");
      },
      {},
      evidence,
    );
  expect([...evidence(names, 0, 0)!]).toEqual([0, 5]);
  expect(match(0)).toBe(false);
  expect(match(3)).toBe(true);
});
