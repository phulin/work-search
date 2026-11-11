import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parse,
  queryTerms,
  type Node,
  QuerySyntaxError,
} from "../src/query/parser.js";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { handler } from "../src/worker/handler.js";
import { tokenize, type Document } from "../src/query/tokenize.js";
import { reference } from "./reference.js";
// Brute-force oracle scans original tokens and all interval pairs, never postings.
function oracle(
  d: Document,
  n: Node,
  field: "all" | "body" | "title" = "all",
): boolean {
  const fields = (["body", "title"] as const).filter(
    (f) => field === "all" || field === f,
  );
  const text = { body: tokenize(d.body), title: tokenize(d.title ?? "") };
  type S = [string, number, number];
  function spans(x: Node): S[] {
    if (x.kind === "term")
      return fields.flatMap((f) =>
        text[f].flatMap((t, i) => (t === x.term ? [[f, i, i] as S] : [])),
      );
    if (x.kind === "phrase")
      return fields.flatMap((f) =>
        text[f].flatMap((_, i) =>
          text[f].slice(i, i + x.terms.length).join("\0") === x.terms.join("\0")
            ? [[f, i, i + x.terms.length - 1] as S]
            : [],
        ),
      );
    if (x.kind === "or") return [...spans(x.left), ...spans(x.right)];
    if (x.kind === "except") return yes(x.right) ? [] : spans(x.left);
    if (x.kind === "and") {
      if (!yes(x.left) || !yes(x.right)) return [];
      const a = spans(x.left),
        b = spans(x.right);
      if (!a.length) return b;
      if (!b.length) return a;
    }
    if (x.kind === "and" || x.kind === "near") {
      const out: S[] = [];
      for (const a of spans(x.left))
        for (const b of spans(x.right)) {
          if (a[0] !== b[0]) continue;
          const gap = Math.max(a[1], b[1]) - Math.min(a[2], b[2]);
          if (
            x.kind === "near" &&
            (gap <= 0 || gap > x.distance || (x.ordered && a[2] >= b[1]))
          )
            continue;
          out.push([a[0], Math.min(a[1], b[1]), Math.max(a[2], b[2])]);
        }
      return out;
    }
    return [];
  }
  function yes(x: Node): boolean {
    switch (x.kind) {
      case "all":
        return true;
      case "empty":
        return false;
      case "not":
        return !yes(x.child);
      case "and":
        return yes(x.left) && yes(x.right);
      case "or":
        return yes(x.left) || yes(x.right);
      case "except":
        return yes(x.left) && !yes(x.right);
      default:
        return spans(x).length > 0;
    }
  }
  return yes(n);
}
describe("connector grammar", () => {
  it("uses OR before AND, numeric distances ascending, and left-associative ties", () => {
    const n = parse("a AND b OR c");
    expect(n.kind).toBe("and");
    expect("right" in n && n.right.kind).toBe("or");
    const p = parse("a /10 b /2 c");
    expect(p.kind).toBe("near");
    expect("right" in p && p.right.kind).toBe("near");
    expect("right" in p && "distance" in p.right && p.right.distance).toBe(2);
    const tie = parse("a /2 b /2 c");
    expect("left" in tie && tie.left.kind).toBe("near");
    expect(queryTerms(parse('"AND" OR "a a" AND NOT b'))).toEqual([
      "and",
      "a",
      "b",
    ]);
  });
  it("maps sentence and paragraph connectors to token distances", () => {
    for (const [q, n] of [
      ["a /s b", 25],
      ["a /p b", 75],
      ["a w/s b", 25],
    ] as const) {
      const ast = parse(q);
      expect(ast.kind === "near" && ast.distance).toBe(n);
    }
  });
  it.each([
    "a AND",
    "OR a",
    "a /0 b",
    "a /256 b",
    "a /wat b",
    "(a OR b",
    "a)",
    '"unclosed',
    '""',
    "neglig!",
    "title(red)",
    "ATLEAST3(red)",
    "cat*",
    "title:foo",
    "a AND OR b",
    "a BUT b",
    "a /2",
    "((((((((((((((((((((((((((((((((((a))))))))))))))))))))))))))))))))))",
  ])("rejects malformed or unsupported syntax: %s", (q) =>
    expect(() => parse(q)).toThrow(QuerySyntaxError),
  );
});
let root: string;
const docs: Document[] = [
  {
    id: "a",
    body: "red fox jumps. blue dog",
    title: "Café 東京",
    metadata: { x: 1 },
  },
  { id: "b", body: "fox red dog", title: "red fox" },
  { id: "c", body: "red red fox" },
  { id: "d", body: "red", title: "fox" },
  { id: "e", body: "red " + Array(24).fill("x").join(" ") + " fox" },
  { id: "f", body: "red " + Array(25).fill("x").join(" ") + " fox" },
  { id: "g", body: "red " + Array(74).fill("x").join(" ") + " fox" },
  { id: "h", body: "red " + Array(75).fill("x").join(" ") + " fox" },
  { id: "empty", body: "" },
  ...Array.from({ length: 70 }, (_, i) => ({
    id: `r${i}`,
    body: Array.from(
      { length: 15 },
      (_, j) =>
        ["red", "fox", "dog", "blue", "café", "東京"][
          (i * 13 + j * j + 7 * j) % 6
        ],
    ).join(" "),
    title: i % 3 ? "red dog" : "fox blue",
  })),
];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "connectors-"));
  await writeFile(
    join(root, "docs"),
    docs.map((d) => JSON.stringify(d)).join("\n"),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const queries = [
  "red AND (fox OR dog)",
  "(red OR fox) AND NOT blue",
  "red OR fox AND dog",
  '"red fox"',
  '"red red"',
  "red /1 fox",
  "red +1 fox",
  "red /s fox",
  "red /p fox",
  "red /25 fox",
  "red /75 fox",
  "(red OR blue) /2 (fox OR dog)",
  '"red fox" /3 dog',
  "(red /2 fox) /3 dog",
  "(red AND dog) /3 fox",
  'red AND NOT "blue dog"',
  "NOT (red /1 fox)",
  "NOT absent",
  "NOT NOT red",
  "red OR absent",
  "red AND absent",
  '"café 東京"',
  '"AND"',
  "red % blue",
  "red BUT NOT blue",
  "(red AND NOT blue) /3 fox",
  "(red AND (NOT blue)) /3 fox",
  "red AND NOT (blue /1 dog)",
];
describe("positional execution", () => {
  it("matches brute-force results and BM25 ranking across remote, mixed and local budgets", async () => {
    const full = await build({
      input: join(root, "docs"),
      out: join(root, "base"),
      chunkDocs: 3,
      objectBytes: 512,
    });
    const minimum = full.bundleBytes - full.embeddedBytes;
    for (const [name, budget] of [
      ["remote", minimum],
      ["mixed", minimum + 30],
      ["local", 100000],
    ] as const) {
      const out = join(root, name);
      await build({
        input: join(root, "docs"),
        out,
        budget,
        chunkDocs: 5,
        objectBytes: 512,
      });
      const index = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
        store = new FileStorage(join(out, "objects"));
      for (const q of queries) {
        const ast = parse(q),
          expected = docs.filter((d) => oracle(d, ast)),
          terms = queryTerms(ast, true);
        const ranking = terms.length
          ? reference(docs, terms.join(" "), "or")
          : docs.map((d) => ({ id: d.id, score: 0 }));
        const ranked = ranking.filter((r) =>
          expected.some((d) => d.id === r.id),
        ); // Add zero-score complement-only matches.
        for (const d of expected)
          if (!ranked.some((r) => r.id === d.id))
            ranked.push({ id: d.id, score: 0 });
        ranked.sort(
          (a, b) =>
            b.score - a.score ||
            docs.findIndex((d) => d.id === a.id) -
              docs.findIndex((d) => d.id === b.id),
        );
        const actual = await search(index, store, q, { limit: 100 });
        expect(actual.total, q).toBe(expected.length);
        expect(
          actual.results.map((r) => r.id),
          q,
        ).toEqual(ranked.map((r) => r.id));
        actual.results.forEach((r, i) =>
          expect(r.score, q).toBeCloseTo(ranked[i].score, 10),
        );
        if (name === "local") expect(actual.diagnostics.indexRequests).toBe(0);
      }
      for (const field of ["body", "title"] as const)
        for (const q of ['"red fox"', "red /1 fox", "red AND NOT fox"]) {
          const actual = await search(index, store, q, { field, limit: 100 });
          expect(actual.results.map((r) => r.id).sort()).toEqual(
            docs
              .filter((d) => oracle(d, parse(q), field))
              .map((d) => d.id)
              .sort(),
          );
        }
    }
  }, 30000);
  it("does not cross fields and uses exact distance boundaries independent of punctuation", async () => {
    const out = join(root, "boundaries");
    await build({ input: join(root, "docs"), out });
    const i = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
      s = new FileStorage(join(out, "objects"));
    const ids = async (q: string) =>
      (await search(i, s, q, { limit: 100 })).results.map((r) => r.id);
    expect(await ids("red /s fox")).toContain("e");
    expect(await ids("red /s fox")).not.toContain("f");
    expect(await ids("red /p fox")).toContain("g");
    expect(await ids("red /p fox")).not.toContain("h");
    expect(await ids('"red fox"')).not.toContain("d");
    expect(await ids("red /1 red")).toContain("c");
    expect(await ids("red /1 red")).not.toContain("a");
    const h = handler(i, s, true);
    for (const q of ["a AND", "neglig!", "a /0 b"])
      expect(
        (await h(new Request("https://test/search?q=" + encodeURIComponent(q))))
          .status,
      ).toBe(400);
  });
});

it("round trips lazy field positions and rejects malformed positional payloads", async () => {
  const { encodePostings, decodePostings, postingPositions } =
    await import("../src/format/codec.js");
  const list = [
    {
      doc: 0,
      body: 3,
      title: 2,
      bodyPositions: [0, 3, 50000],
      titlePositions: [1, 500],
    },
    { doc: 400, body: 1, title: 0, bodyPositions: [99], titlePositions: [] },
  ];
  const bytes = encodePostings(list),
    decoded = decodePostings(bytes, 2, true);
  expect([...postingPositions(decoded, 0).body]).toEqual([0, 3, 50000]);
  expect([...postingPositions(decoded, 0).title]).toEqual([1, 500]);
  expect([...postingPositions(decoded, 1).body]).toEqual([99]);
  expect(() => postingPositions(decodePostings(bytes), 0)).toThrow(
    "unavailable",
  );
  expect(() =>
    decodePostings(bytes.subarray(0, bytes.length - 1), 2, true),
  ).toThrow();
  expect(() => encodePostings([{ doc: 0, body: 1, title: 0 }])).toThrow(
    "frequency",
  );
  expect(() =>
    decodePostings(new Uint8Array([1, 0, 2, 0, 0, 0]), 1, true),
  ).toThrow("Unsorted");
});

it("bounds positional expansion explicitly rather than silently dropping matches", async () => {
  const { positionalMatcher, QueryResourceError } =
    await import("../src/query/evaluate.js");
  const { encodePostings, decodePostings } =
    await import("../src/format/codec.js");
  const red = decodePostings(
      encodePostings([
        {
          doc: 0,
          body: 4097,
          title: 0,
          bodyPositions: Array.from({ length: 4097 }, (_, i) => i),
          titlePositions: [],
        },
      ]),
      1,
      true,
    ),
    fox = decodePostings(
      encodePostings([
        {
          doc: 0,
          body: 1,
          title: 0,
          bodyPositions: [4097],
          titlePositions: [],
        },
      ]),
      1,
      true,
    );
  expect(() =>
    positionalMatcher(
      parse("(red AND fox) /s fox"),
      new Map([
        ["red", red],
        ["fox", fox],
      ]),
      "all",
    )(0),
  ).toThrow(QueryResourceError);
  expect(() => parse('"' + Array(257).fill("red").join(" ") + '"')).toThrow(
    "256",
  );
});
