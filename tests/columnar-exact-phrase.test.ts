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
} from "../src/columnar/pair-membership.js";
import { parse } from "../src/query/parser.js";
import { tokenize } from "../src/query/tokenize.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
const generation = "b".repeat(64),
  empty = () => ({ positions: [], previous: [], next: [] });
it("executes routed inline and complete external context without a bundled pair descriptor, including authoritative absence", async () => {
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
                ? encodeCompletePairRanges(ranges)
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
    expect([...e.evidence(words, 16999, 0)!]).toEqual([1 - at]);
    expect(e.evidence(["a", "b", "c", "d", "e"], 16999, 0)).toBeUndefined();
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
    expect(used).toBeGreaterThan(10);
  } finally {
    await original?.close();
    await objects?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
