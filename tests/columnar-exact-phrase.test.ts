import { buildHotExactPhrases } from "../scripts/build-hot-exact-phrases.js";
import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildColumnar } from "../bench/columnar/build-fixture.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { Reader } from "../src/columnar/storage.js";
import { ColumnarIndex, leaves } from "../src/columnar/search.js";
import { Packer } from "../src/columnar/packer.js";
import { encodeTermPacket } from "../src/columnar/term-packet.js";
import {
  decodeScoreColumns,
  type Root,
  type Term,
  concat,
} from "../src/columnar/format.js";
import {
  TermDirectory,
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";
import {
  encodePairColumns,
  type PairColumnRow,
} from "../src/columnar/pair-packet.js";
import {
  PairPositionDirectory,
  encodePairPositionDirectory,
  pairPositionChunks,
} from "../src/columnar/pair-positions.js";
import {
  ExactPhraseDirectory,
  encodeExactPhraseDirectory,
  type ExactPairDescriptor,
  completePairRanges,
} from "../src/columnar/exact-phrase-directory.js";
import {
  ExactPhraseExecution,
  planExactPhrases,
  readExactPhrasePairs,
} from "../src/columnar/exact-phrase.js";
import {
  encodeCompletePairRanges,
  decodeCompletePairRanges,
} from "../src/columnar/pair-ranges.js";
import { encodePairPacket } from "../src/columnar/pair-packet.js";
import { PairRouter, encodePairRouter } from "../src/columnar/pair-router.js";
import {
  encodePairMembershipPacket,
  encodePairMembership,
  PairMembershipPacket,
} from "../src/columnar/pair-membership.js";
import { parse } from "../src/query/parser.js";
import { tokenize } from "../src/query/tokenize.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import { positionalMatcher } from "../src/query/evaluate.js";
const generation = "b".repeat(64),
  empty = () => ({ positions: [], previous: [], next: [] });
it("executes routed inline and chunk-directory external context without a bundled pair descriptor, including authoritative absence", async () => {
  const docs = [
      [
        [0, 1, 2, 3],
        [0, 1, 2],
      ],
      [[1, 2, 0, 1, 2, 3], []],
      [
        [0, 1, 4, 2, 3],
        [1, 2, 3],
      ],
    ],
    words = ["a", "b", "c", "d", "x"],
    count = docs.length;
  const rows = (a: number, b: number) =>
    docs.flatMap((fields, doc) => {
      const lists = fields.map((tokens) =>
        tokens.flatMap((id, p) =>
          id === a && tokens[p + 1] === b
            ? [{ position: p, previous: tokens[p - 1], next: tokens[p + 2] }]
            : [],
        ),
      );
      return lists.some((x) => x.length)
        ? [{ doc, body: lists[0], title: lists[1] }]
        : [];
    });
  const positional = encodePairPacket(1, 2, rows(1, 2)),
    ranges = {
      a: 1,
      b: 2,
      generation,
      ranges: [{ object: 0, offset: 0, length: positional.length }],
    };
  expect(decodeCompletePairRanges(encodeCompletePairRanges(ranges))).toEqual(
    ranges,
  );
  const bad = encodeCompletePairRanges(ranges);
  new DataView(bad.buffer).setUint32(56, 0, true);
  expect(() => decodeCompletePairRanges(bad)).toThrow();
  const entries = [];
  for (let a = 0; a < words.length; a++)
    for (let b = 0; b < words.length; b++) {
      const r = rows(a, b);
      if (!r.length) continue;
      entries.push({
        a: words[a],
        b: words[b],
        data: encodePairMembership(
          {
            a,
            b,
            df: r.length,
            body: Uint32Array.from(
              r.filter((x) => x.body.length).map((x) => x.doc),
            ),
            title: Uint32Array.from(
              r.filter((x) => x.title.length).map((x) => x.doc),
            ),
            bodyOccurrences: r.reduce((n, x) => n + x.body.length, 0),
            titleOccurrences: r.reduce((n, x) => n + x.title.length, 0),
            context:
              a === 1 && b === 2
                ? encodePairPositionDirectory(1, 2, generation, [
                    {
                      first: 0,
                      last: count - 1,
                      object: 0,
                      offset: 0,
                      length: positional.length,
                    },
                  ])
                : encodePairPacket(a, b, r),
          },
          count,
        ),
      });
    }
  const members = encodePairMembershipPacket(entries),
    router = new PairRouter(
      encodePairRouter(
        {
          generation,
          baseGeneration: generation,
          documents: count,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [-1],
          commonWords: [],
          completeContext: true,
        },
        [],
        [
          {
            object: 0,
            offset: 0,
            bytes: members.length,
            pairs: entries.length,
            namespace: 0,
            bits: 0,
            prefix: 0,
            crc32: 0,
          },
        ],
        encodePairMembershipPacket([]),
      ),
    );
  const hot = await buildHotExactPhrases(
    router,
    [{ a: "b", b: "c", df: rows(1, 2).length }],
    async () => members,
  );
  expect(hot.descriptors).toBe(1);
  expect(
    new ExactPhraseDirectory(hot.bytes).lookup("b", "c")!.directory,
  ).toEqual(ranges);
  const root = { generation, count, objects: [], hot: {} } as any,
    terms = new Map(
      words.map((w, id) => [
        w,
        {
          id,
          df: count,
          bodyOccurrences: 10,
          titleOccurrences: 3,
          frequencies: [0, 0, 0],
          positional: [0, 0, 1000000],
        } as any,
      ]),
    ),
    alternative = {
      kind: "blocks",
      expectedCandidates: count,
      frequencyBytes: 0,
      positionBytes: 1000000,
    } as any;
  for (const text of ['"a b"', '"a b c"', '"a b c d"', '"b c a"', '"d a b"']) {
    const reader = new Reader(root, {
        read: async () => {
          throw Error("Ordinary word read");
        },
        readNamed: async (key, n) =>
          key.includes("/pairs-") ? members : positional,
      }),
      ast = parse(text),
      catalog = await readExactPhrasePairs(
        ast,
        router,
        undefined,
        reader,
        alternative,
      );
    expect(reader.stats.exactPhraseDiscoveryWaves).toBe(1);
    expect(reader.stats.requests).toBe(1);
    const plans = planExactPhrases(
      ast,
      { lookup: (a, b) => catalog.get(a + "\0" + b) },
      terms,
      alternative,
      16384,
      "all",
      reader,
    );
    expect(plans).toHaveLength(1);
    const execution = new ExactPhraseExecution(plans, reader, "all");
    await execution.window(0, count);
    const phrase = (ast as any).terms as string[],
      ids = phrase.map((w) => words.indexOf(w));
    for (let doc = 0; doc < count; doc++)
      for (let field = 0; field < 2; field++) {
        const tokens = docs[doc][field],
          expected = tokens.flatMap((_, p) =>
            ids.every((id, i) => tokens[p + i] === id) ? [p] : [],
          );
        expect([...execution.evidence(phrase, doc, field)!]).toEqual(expected);
      }
    expect(reader.stats.wordPositionIntegers).toBe(0);
  }
  const lists = new Map(
    words.map((word, id) => [
      word,
      {
        docs: Uint32Array.from(docs, (_, doc) => doc),
        body: Uint32Array.from(
          docs,
          (fields) => fields[0].filter((t) => t === id).length,
        ),
        title: Uint32Array.from(
          docs,
          (fields) => fields[1].filter((t) => t === id).length,
        ),
        bytes: new Uint8Array(),
      },
    ]),
  );
  const direct = (name: string, doc: number, field: number) =>
    docs[doc][field].flatMap((id, p) =>
      id === words.indexOf(name) ? [p] : [],
    );
  for (const kind of ["complete-terms", "documents"] as const) {
    const reader = new Reader(root, {
      read: async () => {
        throw Error("Unnecessary discovery");
      },
      readNamed: async () => {
        throw Error("Unnecessary discovery");
      },
    });
    expect(
      (
        await readExactPhrasePairs(
          parse('"a b" OR x'),
          router,
          undefined,
          reader,
          { ...alternative, kind },
        )
      ).size,
    ).toBe(0);
    expect(reader.stats.requests).toBe(0);
  }
  for (const text of [
    '"a b" OR x',
    '"b c" OR x',
    '"b c" OR b',
    '"b c" OR "c d"',
    '"a b" AND NOT "c d"',
    'NOT "a b"',
    'NOT NOT "a b"',
    '"a b" W/3 d',
    '("a b" OR x) W/3 d',
    '"a b" AND ("a b" W/3 d)',
  ])
    for (const field of ["all", "body", "title"] as const) {
      const reader = new Reader(root, {
          read: async () => {
            throw Error("Unexpected ordinary posting read");
          },
          readNamed: async (key) =>
            key.includes("/pairs-") ? members : positional,
        }),
        ast = parse(text),
        catalog = await readExactPhrasePairs(
          ast,
          router,
          undefined,
          reader,
          alternative,
        ),
        plans = planExactPhrases(
          ast,
          { lookup: (a, b) => catalog.get(a + "\0" + b) },
          terms,
          alternative,
          16384,
          field,
          reader,
        ),
        // Exercise membership truth independently of the cost policy: these
        // tiny inline records are normally cheaper to execute positionally.
        execution = new ExactPhraseExecution(
          text.includes("W/3")
            ? plans
            : plans.map((p) => ({ ...p, membershipOnly: true, groups: [] })),
          reader,
          field,
        );
      await execution.window(0, count);
      const match = positionalMatcher(
          ast,
          lists,
          field,
          direct,
          {},
          execution.evidence,
          execution.truth,
        ),
        reference = positionalMatcher(ast, lists, field, direct);
      const guard = execution.positionGuard(ast, execution.covered, field);
      if (text === '"b c" OR x' && field === "body") {
        expect(guard("b", 2)).toBe(false);
        expect(guard("c", 2)).toBe(false);
      }
      if (
        (text === '"b c" OR b' || text === '"b c" OR "c d"') &&
        field === "body"
      )
        expect(guard(text.endsWith(" b") ? "b" : "c", 2)).toBe(true);
      const guardedMatch = positionalMatcher(
        ast,
        lists,
        field,
        (name, doc, f) => (guard(name, doc) ? direct(name, doc, f) : undefined),
        {},
        execution.evidence,
        execution.truth,
      );
      for (let doc = 0; doc < count; doc++) {
        expect(match(doc), text + field).toBe(
          exhaustive(
            ast,
            docs[doc].map((tokens, f) =>
              (field === "body" && f === 1) || (field === "title" && f === 0)
                ? []
                : tokens.map((t) => words[t]),
            ),
          ),
        );
        // Membership proves truth, while rendering/proximity still uses genuine
        // positions. Never substitute a made-up span for a membership hit.
        expect(match.firstBodySpan(doc)).toEqual(reference.firstBodySpan(doc));
        expect(guardedMatch(doc)).toBe(reference(doc));
        expect(guardedMatch.firstBodySpan(doc)).toEqual(
          reference.firstBodySpan(doc),
        );
      }
      if (text === '"a b" OR x') {
        expect(execution.covered(["a", "b"])).toBe(false);
        expect(reader.stats.exactPhraseReads).toBe(0);
        expect(reader.stats.positionIntegers).toBe(0);
      }
      if (text.includes("W/3"))
        expect(
          plans.find((p) => p.words.join(" ") === "a b")?.membershipOnly,
        ).toBe(false);
    }
});
it("prices dependent winner positions before choosing membership over complete context", () => {
  const docs = Uint32Array.from({ length: 1000 }, (_, i) => i),
    members = new PairMembershipPacket(
      encodePairMembershipPacket([
        {
          a: "b",
          b: "c",
          data: encodePairMembership(
            {
              a: 0,
              b: 1,
              df: docs.length,
              body: docs,
              title: new Uint32Array(),
              bodyOccurrences: 50000000,
              titleOccurrences: 0,
            },
            1000,
          ),
        },
      ]),
    ),
    membership = members.lookup("b", "c", 1000)!,
    terms = new Map(
      ["b", "c"].map((word, id) => [
        word,
        {
          id,
          df: 1000,
          bodyOccurrences: 50000000,
          titleOccurrences: 0,
          frequencies: [0, 0, 100000],
          positional: [0, 0, 100000000],
        } as DirectoryTerm,
      ]),
    );
  const plan = (bytes: number, occurrences: number) =>
    planExactPhrases(
      parse('"b c" OR x'),
      {
        lookup: () => ({
          a: "b",
          b: "c",
          df: 1000,
          bodyDf: 1000,
          titleDf: 0,
          bodyOccurrences: occurrences,
          titleOccurrences: 0,
          membership,
          directory: {
            a: 0,
            b: 1,
            generation,
            ranges: [{ object: 0, offset: 0, length: bytes }],
          },
        }),
      },
      terms,
      {
        kind: "blocks",
        expectedCandidates: 1000,
        frequencyBytes: 200000,
        positionBytes: 200000000,
      },
      16384,
      "body",
    )[0];
  // The small source avoids serial word-position reads for complete results.
  expect(plan(200000, 10000).membershipOnly).toBe(false);
  // Very large occurrence scans can still make membership the cold winner.
  expect(plan(32000000, 50000000).membershipOnly).toBe(true);
});
function product(
  rows: PairColumnRow[],
  a: number,
  b: number,
  baseGeneration: string,
) {
  const chunks = [...pairPositionChunks(a, b, rows, 16384)];
  let offset = 0;
  const directory = new PairPositionDirectory(
    encodePairPositionDirectory(
      a,
      b,
      generation,
      chunks.map((c) => {
        const n = {
          first: c.first,
          last: c.last,
          object: 0,
          offset,
          length: c.data.length,
        };
        offset += c.data.length;
        return n;
      }),
    ),
  );
  const p: ExactPairDescriptor = {
    a: "b",
    b: "c",
    df: rows.length,
    bodyDf: rows.filter((r) => r.body.positions.length).length,
    titleDf: rows.filter((r) => r.title.positions.length).length,
    bodyOccurrences: rows.reduce((n, r) => n + r.body.positions.length, 0),
    titleOccurrences: rows.reduce((n, r) => n + r.title.positions.length, 0),
    directory: completePairRanges(directory),
  };
  return {
    p,
    bytes: concat(chunks.map((c) => c.data)),
    catalog: new ExactPhraseDirectory(
      encodeExactPhraseDirectory(
        { generation, baseGeneration, documents: 40000, objects: [] },
        [p],
      ),
    ),
  };
}
it("answers an authoritatively empty phrase field without reading its nonempty body anchor", async () => {
  const count = 40000,
    { catalog } = product(
      [
        {
          doc: 10,
          body: { positions: [1], previous: [0], next: [0] },
          title: empty(),
        },
      ],
      0,
      1,
      generation,
    ),
    terms = ["b", "c"].map(
      (word, id) =>
        [
          word,
          {
            id,
            df: 1,
            bodyOccurrences: 1,
            titleOccurrences: 0,
            frequencies: [0, 0, 10000000],
            positional: [0, 0, 10000000],
            tree: {
              first: 0,
              last: count - 1,
              b: 1,
              t: 0,
              height: 1,
              score: [0, 0, 64],
              positions: [0, 0, 64],
            },
          },
        ] as [string, DirectoryTerm],
    ),
    directory = new TermDirectory(
      assembleTermDirectory([
        {
          first: "b",
          count: terms.length,
          data: gzipSync(encodeDirectoryBlock(terms)),
        },
      ]),
      count,
    ),
    root: Root = {
      format: "CWS1",
      generation,
      count,
      avgBody: 2,
      avgTitle: 1,
      corpusHash: generation,
      hot: {},
      dictionaries: [],
      objects: [],
      documents: Array.from({ length: Math.ceil(count / 4096) }, () => [
        0, 0, 64,
      ]),
    },
    packet = encodePairMembershipPacket([]),
    router = new PairRouter(
      encodePairRouter(
        {
          generation,
          baseGeneration: generation,
          documents: count,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [-1],
          commonWords: [],
        },
        [],
        [
          {
            object: 0,
            offset: 0,
            bytes: packet.length,
            pairs: 0,
            namespace: 0,
            bits: 0,
            prefix: 0,
            crc32: 0,
          },
        ],
        packet,
      ),
    ),
    index = new ColumnarIndex(
      root,
      undefined,
      directory,
      undefined,
      undefined,
      {
        router,
        N: 0,
        M: 0,
        exactPhrases: catalog,
      },
    ),
    reader = new Reader(root, {
      read: async () => {
        throw Error("Unnecessary score/position read");
      },
    });
  const result = await index.search('"b c"', reader, {
    field: "title",
    exactTotal: true,
  });
  expect(result.results).toEqual([]);
  expect(result.total).toBe(0);
  expect(result.diagnostics.requests).toBe(0);
  expect(result.diagnostics.scorePostingsDecoded).toBe(0);
  expect(result.diagnostics.exactPhraseReads).toBe(0);
});
it("streams split rows and exact 2–4 word evidence through bounded windows, without truncating total transfer", async () => {
  const rows: PairColumnRow[] = Array.from({ length: 17000 }, (_, doc) => ({
    doc,
    body: {
      positions: Array.from(
        { length: doc === 128 ? 5000 : 1 },
        (_, i) => 4 * i + 1,
      ),
      previous: Array.from({ length: doc === 128 ? 5000 : 1 }, () => 1),
      next: Array.from({ length: doc === 128 ? 5000 : 1 }, () => 4),
    },
    title: doc % 3 ? empty() : { positions: [1], previous: [1], next: [4] },
  }));
  const { p, bytes } = product(rows, 1, 2, "a".repeat(64));
  const reads: number[] = [];
  const reader = new Reader(
    { generation, objects: [] },
    {
      read: async () => {
        throw Error("ordinary word read");
      },
      readNamed: async (key, n) => {
        const at = Number(key.split("@")[1]);
        reads.push(n);
        return bytes.slice(at, at + n);
      },
    },
  );
  for (const words of [
    ["b", "c"],
    ["a", "b", "c"],
    ["b", "c", "d"],
    ["a", "b", "c", "d"],
  ]) {
    const ids = words.map((w) => "abcd".indexOf(w)),
      at = words.indexOf("b"),
      plan = {
        words,
        ids,
        at,
        pair: p,
        bytes: bytes.length,
        groups: [] as any,
        cost: 0,
        alternativeCost: 100,
      };
    const fakeTerms = new Map(
      "abcd".split("").map((w, id) => [
        w,
        {
          id,
          bodyOccurrences: 1000000,
          titleOccurrences: 0,
          frequencies: [0, 0, 1],
          positional: [0, 0, 10000000],
        } as unknown as DirectoryTerm,
      ]),
    );
    const planned = planExactPhrases(
      parse('"' + words.join(" ") + '"'),
      product(rows, 1, 2, "a".repeat(64)).catalog,
      fakeTerms,
      {
        kind: "blocks",
        frequencyBytes: 1000000,
        positionBytes: 10000000,
        expectedCandidates: 40000,
      },
      10000,
      "all",
    );
    expect(planned).toHaveLength(1);
    plan.groups = planned[0].groups;
    const e = new ExactPhraseExecution([plan], reader, "all");
    await e.window(0, 16384);
    expect(e.evidence(words, 128, 0)).toHaveLength(5000);
    expect(e.evidence(words, 128, 1)).toHaveLength(0);
    await e.window(16384, 32768);
    // Lookahead retains genuine earlier positions until their score window
    // finishes; advancing a stream must not replace that evidence.
    expect(e.evidence(words, 128, 0)).toHaveLength(5000);
    expect([...e.evidence(words, 16999, 0)!]).toEqual([1 - at]);
    expect(e.evidence(["a", "b", "c", "d", "e"], 16999, 0)).toBeUndefined();
    const filteredReader = new Reader(
        { generation, objects: [] },
        reader.source,
      ),
      filtered = new ExactPhraseExecution(
        [plan],
        filteredReader,
        "all",
        Uint32Array.of(128, 16999),
      );
    await filtered.window(0, 16384);
    await filtered.window(16384, 32768);
    for (const doc of [128, 16999])
      for (const f of [0, 1])
        expect(filtered.evidence(words, doc, f)).toEqual(
          e.evidence(words, doc, f),
        );
    expect(filtered.evidence(words, 127, 0)).toHaveLength(0);
    expect(filteredReader.stats.positionIntegers).toBe(5001);
    const emptyReader = new Reader({ generation, objects: [] }, reader.source),
      none = new ExactPhraseExecution(
        [plan],
        emptyReader,
        "all",
        new Uint32Array(),
      );
    await none.window(0, 32768);
    expect(none.evidence(words, 128, 0)).toHaveLength(0);
    expect(emptyReader.stats.requests).toBe(0);
    e.release(0);
    expect(() => e.evidence(words, 128, 0)).toThrow("buffered windows");
  }
  expect(Math.max(...reads)).toBeLessThanOrEqual(262144);
  expect(reader.stats.exactPhraseOccurrences).toBeGreaterThan(17000);
  expect(reader.stats.wordPositionIntegers).toBe(0);
});

it("exhausts a zero-hit phrase beyond the old total-transfer cutoff with bounded prefetch", async () => {
  const rows: PairColumnRow[] = Array.from({ length: 1024 }, (_, doc) => ({
    doc,
    body: {
      positions: Array.from({ length: 2048 }, (_, i) => i * 3 + 1),
      previous: Array.from({ length: 2048 }, (_, i) => 1000000 + i),
      next: Array.from({ length: 2048 }, () => 4),
    },
    title: empty(),
  }));
  const { catalog, bytes } = product(rows, 1, 2, "a".repeat(64));
  expect(bytes.length).toBeGreaterThan(4 * 1048576);
  const terms = new Map(
    "abcd".split("").map((w, id) => [
      w,
      {
        id,
        bodyOccurrences: 3000000,
        titleOccurrences: 0,
        frequencies: [0, 0, 1],
        positional: [0, 0, 100000000],
      } as unknown as DirectoryTerm,
    ]),
  );
  const plans = planExactPhrases(
    parse('"a b c d"'),
    catalog,
    terms,
    {
      kind: "blocks",
      frequencyBytes: 1000000,
      positionBytes: 100000000,
      expectedCandidates: 40000,
    },
    10000,
    "all",
  );
  const reader = new Reader(
      { generation, objects: [] },
      {
        read: async () => {
          throw Error("Unexpected word position read");
        },
        readNamed: async (key, n) => {
          const at = Number(key.split("@")[1]);
          return bytes.slice(at, at + n);
        },
      },
    ),
    execution = new ExactPhraseExecution(plans, reader, "all");
  await execution.window(0, 16384);
  expect(execution.mask(parse('"a b c d"'), "all").some(Boolean)).toBe(false);
  expect(reader.stats.exactPhraseBytes).toBe(bytes.length);
  expect(reader.stats.exactPhraseOccurrences).toBe(1024 * 2048);
  expect(reader.stats.peakExactPhraseBufferBytes).toBeLessThan(2 * 1048576);
  expect(reader.stats.wordPositionIntegers).toBe(0);
});

it("executes exact pair phrases inside Boolean/proximity expressions with the original scores, ties, pagination and snippets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-exact-phrase-"));
  let original: OfflineObjects | undefined, objects: OfflineObjects | undefined;
  try {
    const docs = Array.from({ length: 600 }, (_, i) => ({
      id: `d${String(i).padStart(4, "0")}`,
      title: i % 5 ? "b c" : "a b c d",
      body:
        (i % 3 ? "a b c d other " : "a b c x other ").repeat(300) +
        (i % 7 ? "" : " rare"),
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const root = await buildColumnar({
      input: dir + "/input",
      out: dir + "/index",
    });
    original = new OfflineObjects(dir + "/index", root);
    const r = new Reader(root, original.source),
      entries: [string, Term][] = [];
    for (const d of root.dictionaries)
      entries.push(
        ...JSON.parse(new TextDecoder().decode(await original.read(d.ref))),
      );
    const store = new Packer(dir + "/index/packs", {
        next: root.objects.length,
        objects: root.objects,
      }),
      terms: [string, DirectoryTerm][] = [];
    for (const [name, t] of entries) {
      const blocks = [];
      let bodyOccurrences = 0,
        titleOccurrences = 0;
      for (const branch of await leaves(r, t.tree, 0, root.count)) {
        const scores = await r.read(branch.score),
          positions = await r.read(branch.positions),
          s = decodeScoreColumns(scores);
        bodyOccurrences += s.body.reduce((n, x) => n + x, 0);
        titleOccurrences += s.title.reduce((n, x) => n + x, 0);
        blocks.push({ branch, scores, positions });
      }
      const p = encodeTermPacket(t.id, blocks);
      terms.push([
        name,
        {
          ...t,
          bodyOccurrences,
          titleOccurrences,
          frequencies: store.put(p.frequencies),
          positional: store.put(p.positional),
        },
      ]);
    }
    store.flush();
    const directory = new TermDirectory(
        assembleTermDirectory([
          {
            first: terms[0][0],
            count: terms.length,
            data: gzipSync(encodeDirectoryBlock(terms)),
          },
        ]),
        root.count,
      ),
      ids = new Map(terms.map(([w, t]) => [w, t.id]));
    const pairRows = docs.map((d, doc) => {
      const fields = [tokenize(d.body), tokenize(d.title)].map((tokens) => {
        const positions: number[] = [],
          previous: number[] = [],
          next: number[] = [];
        for (let p = 0; p + 1 < tokens.length; p++)
          if (tokens[p] === "b" && tokens[p + 1] === "c") {
            positions.push(p);
            previous.push(p ? ids.get(tokens[p - 1])! + 1 : 0);
            next.push(p + 2 < tokens.length ? ids.get(tokens[p + 2])! + 1 : 0);
          }
        return { positions, previous, next };
      });
      return { doc, body: fields[0], title: fields[1] };
    });
    const { p, bytes } = product(
      pairRows,
      ids.get("b")!,
      ids.get("c")!,
      root.generation,
    );
    const exactPhrases = new ExactPhraseDirectory(
      encodeExactPhraseDirectory(
        {
          generation,
          baseGeneration: root.generation,
          documents: root.count,
          objects: [],
        },
        [p],
      ),
    );
    const memberships = new Map<
      string,
      {
        a: string;
        b: string;
        body: Set<number>;
        title: Set<number>;
        bodyOccurrences: number;
        titleOccurrences: number;
      }
    >();
    for (let doc = 0; doc < docs.length; doc++)
      for (const f of ["body", "title"] as const) {
        const tokens = tokenize(docs[doc][f]);
        for (let i = 0; i + 1 < tokens.length; i++) {
          const a = tokens[i],
            b = tokens[i + 1],
            key = a + "\0" + b;
          let p = memberships.get(key);
          if (!p)
            memberships.set(
              key,
              (p = {
                a,
                b,
                body: new Set(),
                title: new Set(),
                bodyOccurrences: 0,
                titleOccurrences: 0,
              }),
            );
          p[f].add(doc);
          if (f === "body") p.bodyOccurrences++;
          else p.titleOccurrences++;
        }
      }
    const members = encodePairMembershipPacket(
      [...memberships.values()].map((p) => ({
        a: p.a,
        b: p.b,
        data: encodePairMembership(
          {
            a: ids.get(p.a)!,
            b: ids.get(p.b)!,
            df: new Set([...p.body, ...p.title]).size,
            body: Uint32Array.from(p.body),
            title: Uint32Array.from(p.title),
            bodyOccurrences: p.bodyOccurrences,
            titleOccurrences: p.titleOccurrences,
          },
          root.count,
        ),
      })),
    );
    const router = new PairRouter(
      encodePairRouter(
        {
          generation,
          baseGeneration: root.generation,
          documents: root.count,
          targetBytes: 131072,
          contextBytes: 0,
          namespaces: [],
          roots: [-1],
          commonWords: [],
        },
        [],
        [
          {
            object: 1,
            offset: 0,
            bytes: members.length,
            pairs: memberships.size,
            namespace: 0,
            bits: 0,
            prefix: 0,
            crc32: 0,
          },
        ],
        encodePairMembershipPacket([]),
      ),
    );
    objects = new OfflineObjects(dir + "/index", root);
    const source = {
        ...objects.source,
        readNamed: async (address: string, n: number) => {
          if (address.includes("/pairs-")) return members;
          const at = Number(address.split("@")[1]);
          return bytes.slice(at, at + n);
        },
      },
      index = new ColumnarIndex(
        root,
        undefined,
        directory,
        undefined,
        undefined,
        { router, N: 0, M: 0, exactPhrases },
      ),
      control = new ColumnarIndex(root);
    let used = 0;
    for (const q of [
      '"a b c d"',
      '"a b c"',
      '"b c d"',
      '"b c"',
      '"a b c d" AND other',
      '"a b c d" OR rare',
      'other AND NOT "a b c d"',
      'NOT NOT "a b c d"',
      'NOT "a b c d"',
      'NOT ("a b c d" OR "b c x")',
      '"a b c d" W/3 other',
      '"a b c d" AND NOT rare',
      '"a b c d" OR "b c x"',
      '"a b c d" AND NOT "b c x"',
      '"a b c d" W/3 "b c x"',
      '"a b c d x"',
    ])
      for (const field of ["all", "body", "title"] as const) {
        const options = { field, limit: 7, exactTotal: true, titleBoost: 3 };
        const result = await index.search(q, new Reader(root, source), options),
          expected = await control.search(
            q,
            new Reader(root, objects.source),
            options,
          );
        expect(result.results, q + field).toEqual(expected.results);
        expect(result.total).toBe(expected.total);
        expect(result.total).toBe(
          docs.filter((d) =>
            exhaustive(
              parse(q),
              [tokenize(d.body), tokenize(d.title)].map((f, i) =>
                (field === "body" && i === 1) || (field === "title" && i === 0)
                  ? []
                  : f,
              ),
            ),
          ).length,
        );
        if (result.diagnostics.executor === "exact-phrase-blocks") {
          used++;
          if (!q.includes("W/"))
            expect(result.diagnostics.wordPositionIntegers).toBe(0);
          if (q === '"a b c d"') {
            expect(result.diagnostics.plannedPairPackets).toBe(0);
            expect(result.diagnostics.plannedPresenceLists).toBe(0);
            expect(result.diagnostics.pairDirectoryRanges).toBe(0);
          }
        }
        if (q === '"a b c d"' && result.results.length) {
          const last = result.results.at(-1)!;
          const after = { score: last.score, doc: last.doc };
          const next = await index.search(q, new Reader(root, source), {
              ...options,
              after,
            }),
            want = await control.search(q, new Reader(root, objects.source), {
              ...options,
              after,
            });
          expect(next.results).toEqual(want.results);
          expect(next.total).toBe(want.total);
        }
      }
    expect(used).toBeGreaterThan(0);
    // The same complete descriptor discovered in the first pair read must be
    // executable without being duplicated in the bundled hot-pair table.
    const routedMembers = encodePairMembershipPacket(
      [...memberships.values()].map((m) => ({
        a: m.a,
        b: m.b,
        data: encodePairMembership(
          {
            a: ids.get(m.a)!,
            b: ids.get(m.b)!,
            df: new Set([...m.body, ...m.title]).size,
            body: Uint32Array.from(m.body),
            title: Uint32Array.from(m.title),
            bodyOccurrences: m.bodyOccurrences,
            titleOccurrences: m.titleOccurrences,
            context:
              m.a === "b" && m.b === "c"
                ? encodeCompletePairRanges(p.directory)
                : undefined,
          },
          root.count,
        ),
      })),
    );
    const routedDirectory = new TermDirectory(
      assembleTermDirectory([
        {
          first: terms[0][0],
          count: terms.length,
          data: gzipSync(encodeDirectoryBlock(terms)),
        },
      ]),
      root.count,
    );
    // Discovery, rather than the bundled planning pass, supplies these terms.
    routedDirectory.lookupBundled = async () => new Map();
    const routed = new ColumnarIndex(
      root,
      undefined,
      routedDirectory,
      undefined,
      undefined,
      {
        router: new PairRouter(
          encodePairRouter(
            {
              ...router.metadata,
              completeContext: true,
            },
            [],
            [
              {
                object: 1,
                offset: 0,
                bytes: routedMembers.length,
                pairs: memberships.size,
                namespace: 0,
                bits: 0,
                prefix: 0,
                crc32: 0,
              },
            ],
            encodePairMembershipPacket([]),
          ),
        ),
        N: 0,
        M: 0,
      },
    );
    for (const field of ["all", "body", "title"] as const) {
      const options = { field, limit: 7, titleBoost: 3, exactTotal: true },
        result = await routed.search(
          '"a b c d"',
          new Reader(root, {
            ...source,
            readNamed: async (address, n) =>
              address.includes("/pairs-")
                ? routedMembers
                : source.readNamed(address, n),
          }),
          options,
        ),
        expected = await control.search(
          '"a b c d"',
          new Reader(root, objects.source),
          options,
        );
      expect(result.results).toEqual(expected.results);
      expect(result.total).toBe(expected.total);
      if (field !== "title") {
        expect(result.diagnostics.executor, field).toBe("exact-phrase-blocks");
        expect(result.diagnostics.wordPositionIntegers).toBe(0);
        expect(result.diagnostics.exactPhraseReads).toBeGreaterThan(0);
        expect(result.diagnostics.pairPositionChunks).toBe(0);
      }
    }
  } finally {
    await original?.close();
    await objects?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
