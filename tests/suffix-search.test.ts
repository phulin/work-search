import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ColumnarIndex } from "../src/columnar/search.js";
import { Reader } from "../src/columnar/storage.js";
import {
  type Root,
  type Ref,
  type Branch,
  encodeScores,
} from "../src/columnar/format.js";
import { encodePositions } from "../src/columnar/positions.js";
import { encodeTermPacket } from "../src/columnar/term-packet.js";
import {
  TermDirectory,
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";
import {
  DocumentDirectory,
  encodeDocumentDirectory,
  pack,
} from "../src/columnar/document-directory.js";
import {
  encodeDocumentPackage,
  documentPrefix,
} from "../src/columnar/document-package.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { SuffixEvidence } from "../src/suffix/evidence.js";
import { searchWithSuffix } from "../src/suffix/search.js";
import {
  scoredConjunction,
  rankSuffixConjunction,
} from "../src/suffix/boolean-rank.js";
import { buildSuffixIndex } from "../scripts/suffix-builder.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { tokenize } from "../src/query/tokenize.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import { bm25 } from "../src/query/engine.js";

it("uses suffix matches with the term scorer for nested Boolean/proximity queries and keeps presentation and cursors exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suffix-search-"));
  try {
    const docs = Array.from({ length: 60 }, (_, doc) => ({
        doc,
        id: String(doc),
        title: doc % 3 ? "a b" : "c a",
        body:
          (doc % 2 ? "a b a c d" : "a x b c d") + (doc % 5 ? "" : " a b c d a"),
        metadata: { doc },
      })),
      words = ["a", "b", "c", "d", "x"],
      ids = new Map(words.map((w, i) => [w, i + 1])),
      numeric = docs.map((d) => ({
        doc: d.doc,
        body: Uint32Array.from(tokenize(d.body), (w) => ids.get(w)!),
        title: Uint32Array.from(tokenize(d.title), (w) => ids.get(w)!),
      })),
      df = new Uint32Array(6);
    for (const d of numeric)
      for (const id of new Set([...d.body, ...d.title])) df[id]++;
    const root: Root = {
        format: "CWS1",
        generation: "a".repeat(64),
        count: docs.length,
        corpusHash: "c".repeat(64),
        avgBody: numeric.reduce((n, d) => n + d.body.length, 0) / docs.length,
        avgTitle: 2,
        objects: [],
        documents: [],
        dictionaries: [],
        hot: {},
      },
      objects: Uint8Array[] = [],
      named = new Map<string, Uint8Array>(),
      groups = [];
    const put = (data: Uint8Array): Ref => {
      const id = objects.length;
      objects.push(data);
      root.objects.push({
        name: `plan-${id}.bin`,
        size: data.length,
        sha256: "e".repeat(64),
        checksums: [],
      });
      return [id, 0, data.length];
    };
    const terms: [string, DirectoryTerm][] = [];
    for (const word of words) {
      const id = ids.get(word)!,
        rows = numeric.filter(
          (d) => d.body.includes(id) || d.title.includes(id),
        ),
        positions = rows.map((d) => ({
          body: Array.from(d.body, (_, p) => p).filter((p) => d.body[p] === id),
          title: Array.from(d.title, (_, p) => p).filter(
            (p) => d.title[p] === id,
          ),
        })),
        body = positions.map((p) => p.body.length),
        title = positions.map((p) => p.title.length),
        scores = encodeScores(
          rows.map((d) => d.doc),
          body,
          title,
          rows.map((d) => d.body.length),
          rows.map((d) => d.title.length),
        ),
        pos = encodePositions(positions),
        branch: Branch = {
          first: rows[0].doc,
          last: rows.at(-1)!.doc,
          count: rows.length,
          height: 0,
          b: Math.max(
            ...rows.map((d, i) =>
              bm25(body[i], df[id], root.count, d.body.length, root.avgBody),
            ),
          ),
          t: Math.max(
            ...rows.map((d, i) =>
              bm25(title[i], df[id], root.count, d.title.length, root.avgTitle),
            ),
          ),
          score: put(scores),
          positions: put(pos),
          locators: [0, 0, 0],
        },
        packet = encodeTermPacket(id, [{ branch, scores, positions: pos }]);
      terms.push([
        word,
        {
          id,
          df: df[id],
          tree: branch,
          bodyOccurrences: body.reduce((n, x) => n + x, 0),
          titleOccurrences: title.reduce((n, x) => n + x, 0),
          frequencies: put(packet.frequencies),
          positional: put(packet.positional),
        },
      ]);
    }
    for (const d of docs) {
      const packet = await encodeDocumentPackage(d, ids),
        sha = createHash("sha256").update(packet).digest("hex");
      named.set(sha + "/plan-0.bin", packet);
      groups.push({
        first: d.doc,
        end: d.doc + 1,
        sha256: sha,
        offsets: pack([0, packet.length], true),
        prefixes: pack([documentPrefix(packet)]),
        verificationBytes: pack([documentPrefix(packet)]),
      });
    }
    root.documentPackages = {
      generation: "b".repeat(64),
      count: root.count,
      averageBytes: 1000,
      bytes: 100000,
      locators: { sha256: "f".repeat(64), bytes: 100, groups: groups.length },
    };
    const td = new TermDirectory(
        assembleTermDirectory([
          {
            first: words[0],
            count: words.length,
            data: gzipSync(encodeDirectoryBlock(terms)),
          },
        ]),
        root.count,
      ),
      dd = new DocumentDirectory(encodeDocumentDirectory(groups, root.count)),
      engine = new ColumnarIndex(root, undefined, td, undefined, dd),
      source = {
        read: async (key: string, at: number, n: number) =>
          objects[Number(/plan-(\d+)/.exec(key)![1])].subarray(at, at + n),
        readNamed: async (address: string, n: number) => {
          const [key, offset] = address.split("@");
          return named
            .get(key)!
            .subarray(Number(offset ?? 0), Number(offset ?? 0) + n);
        },
        readWhole: async (key: string, range: any) => ({
          data: named
            .get(key)!
            .subarray(range.offset, range.offset + range.length),
        }),
      };
    const manifest = await buildSuffixIndex(
        (async function* () {
          yield* numeric;
        })(),
        {
          count: root.count,
          avgBody: root.avgBody,
          avgTitle: root.avgTitle,
          titleBoost: 2,
          df,
        },
        directory,
        root.generation,
      ),
      suffix = () =>
        new SuffixReader(manifest, async (file, at, n) =>
          (await readFile(directory + "/" + file)).subarray(at, at + n),
        );
    const queries = [
      '"a" AND "d"',
      'NOT "x"',
      '"a b"',
      '"a b c d"',
      '"a a"',
      '"a b" AND "c d"',
      '"a b a" AND "c d"',
      '"a b" AND "b c"',
      '("a b" AND "c d") AND "x x"',
      '"a b" OR "c d"',
      '"a b" AND NOT "b c"',
      'NOT ("a b" OR "d a")',
      '("a b" OR c) W/2 d',
      '"a b" W/3 "c d"',
      '("a b" AND c) OR (d AND NOT "b c")',
      'NOT (("a b" AND x) OR ("c d" AND NOT x))',
      '("a b" OR NOT x) AND ("c d" OR x)',
      'NOT ("a b" W/2 "c d")',
      '("a b" % "c d") OR ("b c" AND NOT x)',
    ];
    for (const q of queries)
      for (const field of ["all", "body", "title"] as const) {
        const ast = parse(q),
          expected = docs
            .filter((d) =>
              exhaustive(
                ast,
                field === "all"
                  ? [tokenize(d.body), tokenize(d.title)]
                  : [
                      field === "body" ? tokenize(d.body) : [],
                      field === "title" ? tokenize(d.title) : [],
                    ],
              ),
            )
            .map((d) => {
              let score = 0;
              for (const name of queryTerms(ast, true)) {
                const id = ids.get(name)!,
                  n = numeric[d.doc];
                score +=
                  (field !== "title"
                    ? bm25(
                        n.body.filter((x) => x === id).length,
                        df[id],
                        root.count,
                        n.body.length,
                        root.avgBody,
                      )
                    : 0) +
                  (field !== "body"
                    ? 2 *
                      bm25(
                        n.title.filter((x) => x === id).length,
                        df[id],
                        root.count,
                        n.title.length,
                        root.avgTitle,
                      )
                    : 0);
              }
              return { doc: d.doc, score };
            })
            .sort((a, b) => b.score - a.score || a.doc - b.doc),
          options = { field, limit: 7, exactTotal: false },
          evidence = new SuffixEvidence();
        const collect = async (n: ReturnType<typeof parse>): Promise<void> => {
          if (n.kind === "phrase")
            await evidence.add(
              n.terms,
              Uint32Array.from(n.terms, (w) => ids.get(w)!),
              suffix(),
            );
          else if (n.kind === "not") await collect(n.child);
          else if ("left" in n) {
            await collect(n.left);
            await collect(n.right);
          }
        };
        await collect(ast);
        const result = await engine.search(q, new Reader(root, source), {
          ...options,
          phraseExecution: { generation: root.generation, execution: evidence },
        });
        expect(
          result.results.map((h) => h.doc),
          q + field,
        ).toEqual(expected.slice(0, 7).map((h) => h.doc));
        for (const bits of [8, 16] as const) {
          const actual = await searchWithSuffix(
            engine,
            suffix(),
            q,
            new Reader(root, source),
            options,
            { bits, rangeMax: true },
          );
          expect(
            actual.results.map((h) => h.doc),
            q + field,
          ).toEqual(expected.slice(0, 7).map((h) => h.doc));
          if (scoredConjunction(ast) && field === "all") {
            // Exercise additive phrase ranking even when the automatic planner
            // correctly prefers this tiny corpus's complete-term read.
            const ranked = await rankSuffixConjunction(
              suffix(),
              scoredConjunction(ast)!.map((words) =>
                Uint32Array.from(words, (w) => ids.get(w)!),
              ),
              { bits, limit: 7, rangeMax: true },
              async (docs) =>
                Float64Array.from(
                  docs,
                  (d) => expected.find((e) => e.doc === d)!.score,
                ),
            );
            expect(ranked!.map((h) => h.doc)).toEqual(
              expected.slice(0, 7).map((h) => h.doc),
            );
          }
          if (scoredConjunction(ast) && bits === 16) {
            const reads: string[] = [],
              few = new SuffixReader(manifest, async (file, at, n) => {
                reads.push(file);
                return (await readFile(directory + "/" + file)).subarray(
                  at,
                  at + n,
                );
              }),
              ranked = await rankSuffixConjunction(
                few,
                scoredConjunction(ast)!.map((words) =>
                  Uint32Array.from(words, (w) => ids.get(w)!),
                ),
                { bits: 16, limit: 100, field },
                async (documents) =>
                  Float64Array.from(
                    documents,
                    (d) => expected.find((e) => e.doc === d)!.score,
                  ),
              );
            expect(ranked!.map((h) => h.doc)).toEqual(
              expected.map((h) => h.doc),
            );
            expect(
              reads.some(
                (file) => file === "flags" || file.startsWith("score"),
              ),
            ).toBe(false);
            expect(few.stats.intersectionCandidates).toBe(expected.length);
          }
          for (const h of actual.results) {
            expect(h.score).toBeCloseTo(
              expected.find((e) => e.doc === h.doc)!.score,
              12,
            );
            expect(h.id).toBe(String(h.doc));
            expect(h.metadata).toEqual({ doc: h.doc });
            expect(h.snippet).toBeDefined();
          }
          if (scoredConjunction(ast) && actual.results.length) {
            const after = actual.results.at(-1)!,
              next = await searchWithSuffix(
                engine,
                suffix(),
                q,
                new Reader(root, source),
                { ...options, after: { doc: after.doc, score: after.score } },
                { bits, rangeMax: false },
              );
            expect(next.results.map((h) => h.doc)).toEqual(
              expected.slice(7, 14).map((h) => h.doc),
            );
          }
        }
      }
    const bounded = suffix();
    expect(
      await rankSuffixConjunction(
        bounded,
        [Uint32Array.of(1, 2), Uint32Array.of(3, 4)],
        { bits: 8, limit: 7 },
        async () => {
          throw Error("Must not rescore");
        },
        1,
      ),
    ).toBeUndefined();
    expect(bounded.stats.rescoreCandidates).toBe(0);
    await expect(
      engine.search('"a b"', new Reader(root, source), {
        phraseExecution: {
          generation: "0".repeat(64),
          execution: new SuffixEvidence(),
        },
      }),
    ).rejects.toThrow("generation");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
it("combines scores only for mandatory phrases with disjoint normalized words", () => {
  expect(scoredConjunction(parse('"a b a" AND "c d"'))).toEqual([
    ["a", "b", "a"],
    ["c", "d"],
  ]);
  for (const q of [
    '"a b" AND "b c"',
    '"a b" OR "c d"',
    '"a b" AND NOT "c d"',
    '"a b" W/2 "c d"',
    '"a b" AND c',
    '"a b c d e f" AND "g h"',
  ])
    expect(scoredConjunction(parse(q)), q).toBeUndefined();
});
