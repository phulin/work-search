import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildColumnar } from "../bench/columnar/build-fixture.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { Reader } from "../src/columnar/storage.js";
import { ColumnarIndex, leaves, type Options } from "../src/columnar/search.js";
import { Packer } from "../src/columnar/packer.js";
import { encodeTermPacket } from "../src/columnar/term-packet.js";
import {
  decodeScoreColumns,
  type Term,
  type Root,
} from "../src/columnar/format.js";
import {
  TermDirectory,
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";
import {
  DocumentPackage,
  encodeDocumentPackage,
} from "../src/columnar/document-package.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { tokenize } from "../src/query/tokenize.js";
import { encodePairPacket, type PairRow } from "../src/columnar/pair-packet.js";
import { encodePairDirectory } from "../src/columnar/pair-directory.js";
import {
  executePackets,
  packetPlan,
} from "../src/columnar/packet-execution.js";
import {
  encodePairMembership,
  encodePairMembershipPacket,
} from "../src/columnar/pair-membership.js";
import { encodePairRouter, PairRouter } from "../src/columnar/pair-router.js";
import { crc32 } from "../src/format/codec.js";
import { executePhraseFrequencies } from "../src/columnar/phrase-frequency.js";
import {
  ExactPhraseExecution,
  type ExactPhrasePlan,
} from "../src/columnar/exact-phrase.js";
import { PairPacket } from "../src/columnar/pair-packet.js";
it("complete terms and anchor packages preserve exhaustive Boolean/positional matching, scores, fields, ties and cursors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-packets-"));
  let original: OfflineObjects | undefined, objects: OfflineObjects | undefined;
  try {
    const docs = Array.from({ length: 600 }, (_, i) => ({
      id: `d${String(i).padStart(4, "0")}`,
      title: i % 7 ? "Court alpha" : "Titleonly beta",
      body:
        (i === 0 ? "long ".repeat(30000) : "") +
        (i < 5 ? "rare " : "") +
        (i % 3 ? "alpha gap beta" : "alpha beta gamma") +
        (i % 11 ? "" : " Δelta beta"),
      metadata: { i },
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const root = await buildColumnar({
        input: dir + "/input",
        out: dir + "/index",
      }),
      before = structuredClone(root);
    original = new OfflineObjects(dir + "/index", before);
    const reader = new Reader(before, original.source),
      entries: [string, Term][] = [];
    async function dictionary(fs: Root["dictionaries"], h: number) {
      for (const f of fs) {
        const value = JSON.parse(
          new TextDecoder().decode(await original!.read(f.ref)),
        );
        if (h) await dictionary(value, h - 1);
        else entries.push(...value);
      }
    }
    await dictionary(root.dictionaries, root.dictionaryHeight ?? 0);
    const packer = new Packer(dir + "/index/packs", {
        next: root.objects.length,
        objects: root.objects,
      }),
      terms: [string, DirectoryTerm][] = [];
    for (const [name, t] of entries) {
      let bodyOccurrences = 0,
        titleOccurrences = 0;
      const blocks = [];
      for (const branch of await leaves(reader, t.tree, 0, root.count)) {
        const scores = await reader.read(branch.score),
          positions = await reader.read(branch.positions),
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
          frequencies: packer.put(p.frequencies),
          positional: packer.put(p.positional),
        },
      ]);
    }
    packer.flush();
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
      ids = new Map(terms.map(([name, t]) => [name, t.id])),
      packages = new Map<number, Uint8Array>();
    for (let doc = 0; doc < docs.length; doc++)
      packages.set(
        doc,
        await encodeDocumentPackage({ ...docs[doc], doc }, ids),
      );
    objects = new OfflineObjects(dir + "/index", root);
    const complete = new ColumnarIndex(root, undefined, directory),
      candidate = new ColumnarIndex(root, undefined, directory, {
        averageBytes: 500,
        async load(doc) {
          return new DocumentPackage(packages.get(doc)!, doc);
        },
      }),
      control = new ColumnarIndex(before);
    for (const q of [
      '"alpha beta gamma"',
      '"Court alpha"',
      '"beta beta"',
      '"long long"',
    ]) {
      const ast = parse(q);
      if (ast.kind !== "phrase") throw Error("Expected phrase");
      const names = queryTerms(ast),
        selected = new Map(terms.filter(([w]) => names.includes(w))),
        words = ast.terms.map((w) => ids.get(w)!),
        rows: PairRow[] = docs.flatMap((d, doc) => {
          const fields = [d.body, d.title].map((text) => {
            const tokens = tokenize(text).map((w) => ids.get(w)!);
            return tokens.flatMap((id, p) =>
              id === words[0] && tokens[p + 1] === words[1]
                ? [
                    {
                      position: p,
                      previous: tokens[p - 1],
                      next: tokens[p + 2],
                    },
                  ]
                : [],
            );
          });
          return fields.some((f) => f.length)
            ? [{ doc, body: fields[0], title: fields[1] }]
            : [];
        }),
        plan: ExactPhrasePlan = {
          words: ast.terms,
          ids: words,
          at: 0,
          bytes: 0,
          groups: [],
          cost: 0,
          alternativeCost: Infinity,
          pair: {
            a: ast.terms[0],
            b: ast.terms[1],
            df: rows.length,
            bodyDf: rows.filter((r) => r.body.length).length,
            titleDf: rows.filter((r) => r.title.length).length,
            bodyOccurrences: rows.reduce((n, r) => n + r.body.length, 0),
            titleOccurrences: rows.reduce((n, r) => n + r.title.length, 0),
            directory: {
              a: words[0],
              b: words[1],
              generation: root.generation,
              ranges: [],
            },
            inline: rows.length
              ? new PairPacket(encodePairPacket(words[0], words[1], rows))
              : undefined,
          },
        };
      for (const field of ["all", "body", "title"] as const)
        for (const exactTotal of [false, true]) {
          const options: Options = {
            field,
            exactTotal,
            titleBoost: 3,
            limit: 7,
            documentFilter: exactTotal
              ? { prepare: async () => (doc: number) => doc % 2 === 0 }
              : undefined,
          };
          for (let page = 0; page < 2; page++) {
            const reader = new Reader(root, objects.source),
              execution = new ExactPhraseExecution([plan], reader, field),
              loaded: number[] = [],
              result = await executePhraseFrequencies(
                ast,
                execution,
                selected,
                root,
                reader,
                options,
                {
                  averageBytes: 500,
                  load: async (doc) => {
                    loaded.push(doc);
                    return new DocumentPackage(packages.get(doc)!, doc);
                  },
                },
                performance.now(),
              ),
              expected = await control.search(
                q,
                new Reader(before, original.source),
                options,
              );
            expect(result, q + field).toBeDefined();
            expect(result!.results).toEqual(expected.results);
            expect(result!.total).toBe(expected.total);
            expect(loaded.sort((a, b) => a - b)).toEqual(
              result!.results.map((h) => h.doc).sort((a, b) => a - b),
            );
            expect(reader.stats.wordPositionIntegers).toBe(0);
            expect(reader.stats.scoreIOWaves).toBeLessThanOrEqual(1);
            const last = result!.results.at(-1);
            if (!last) break;
            options.after = { score: last.score, doc: last.doc };
          }
        }
    }
    const executors = new Set<string>();
    const broadFilter = {
        count: root.count,
        *values(): Generator<number> {
          throw Error("Broad filter must not force package materialization");
        },
        has: () => true,
        cursor: () => ({ next: () => Infinity }),
        evidence: () => undefined,
        covered: () => false,
      },
      selectiveAst = parse("rare"),
      selectiveReader = new Reader(root, objects.source),
      selectiveTerms = await directory.lookup(
        queryTerms(selectiveAst),
        selectiveReader,
      );
    expect(
      packetPlan(
        selectiveAst,
        selectiveTerms,
        root,
        {},
        {
          averageBytes: 500,
          load: async (doc) => new DocumentPackage(packages.get(doc)!, doc),
          membership: broadFilter,
        },
      ).kind,
    ).toBe("complete-terms");
    const unigramPlan = packetPlan(
      selectiveAst,
      selectiveTerms,
      root,
      {},
      {
        averageBytes: 500,
        load: async (doc) => new DocumentPackage(packages.get(doc)!, doc),
        membership: { ...broadFilter, count: 512 },
      },
      "documents",
    );
    expect(unigramPlan.kind).toBe("documents");
    expect(unigramPlan.anchor).toBe("rare");
    expect(unigramPlan.membershipAnchor).toBeUndefined();
    // Oversized transfer forecasts no longer reject the entire continuation.
    // Such candidates run alone and every candidate remains covered.
    const longQuery = parse('"rare alpha"'),
      longReader = new Reader(root, objects.source),
      longTerms = await directory.lookup(queryTerms(longQuery), longReader),
      load = vi.fn(
        async (doc: number) => new DocumentPackage(packages.get(doc)!, doc),
      );
    const streamedLong = await executePackets(
      longQuery,
      longTerms,
      root,
      longReader,
      { metadata: false, snippets: false },
      {
        averageBytes: 500,
        byteLength: () => 9 * 1048576,
        load,
      },
      "documents",
    );
    expect(streamedLong).toBeDefined();
    expect(load).toHaveBeenCalled();
    // Automatic continuation selection prices real anchor candidates before
    // opening packages; explicit forced experiments above still stream them.
    const pricedLoad = vi.fn(async (doc: number) => load(doc)),
      fallbackCandidates = vi.fn(),
      pricedPackages = {
        averageBytes: 500,
        byteLength: () => 9 * 1048576,
        load: pricedLoad,
        fallbackCandidates,
      };
    expect(
      await executePackets(
        longQuery,
        longTerms,
        root,
        longReader,
        {},
        pricedPackages,
        packetPlan(longQuery, longTerms, root, {}, pricedPackages, "documents"),
      ),
    ).toBeUndefined();
    expect(pricedLoad).not.toHaveBeenCalled();
    expect(fallbackCandidates).toHaveBeenCalledOnce();
    expect(Array.from(fallbackCandidates.mock.calls[0][0])).toEqual([
      0, 1, 2, 3, 4,
    ]);
    const membership = {
      count: docs.length,
      *values() {
        for (let doc = 0; doc < docs.length; doc++) yield doc;
      },
      has: (doc: number) => doc >= 0 && doc < docs.length,
      cursor: () => {
        let doc = 0;
        return { next: () => (doc < docs.length ? doc++ : Infinity) };
      },
      covered: () => false,
      evidence: () => undefined,
    };
    for (const q of [
      '("alpha beta" OR "beta gamma") AND NOT "rare alpha"',
      '"alpha beta" /3 gamma',
    ]) {
      const ast = parse(q),
        terms = await directory.lookup(queryTerms(ast));
      for (const field of ["all", "body", "title"] as const) {
        const options: Options = {
            field,
            limit: 7,
            titleBoost: 3.25,
            exactTotal: true,
          },
          pkgs = {
            averageBytes: 500,
            byteLength: (doc: number) => packages.get(doc)!.length,
            load: async (doc: number) => {
              // Later IDs finish first. Exact totals, ties and search-after
              // must remain independent of network completion order.
              if (doc % 6 === 0) await new Promise((r) => setTimeout(r, 1));
              return new DocumentPackage(packages.get(doc)!, doc);
            },
            membership,
          },
          plan = {
            ...packetPlan(ast, terms, root, options, pkgs),
            kind: "documents" as const,
            membershipAnchor: membership,
          },
          expected = await control.search(
            q,
            new Reader(before, original.source),
            options,
          ),
          got = await executePackets(
            ast,
            terms,
            root,
            new Reader(root, objects.source),
            options,
            pkgs,
            plan,
          );
        expect(got!.total).toBe(expected.total);
        expect(got!.diagnostics.packageCandidates).toBe(600);
        expect(got!.results.map((h) => h.id)).toEqual(
          expected.results.map((h) => h.id),
        );
        got!.results.forEach((h, i) =>
          expect(h.score).toBeCloseTo(expected.results[i].score, 11),
        );
        expect(got!.diagnostics.peakPackageBatchBytes).toBeLessThanOrEqual(
          4 * 1048576,
        );
        expect(got!.diagnostics.peakWinnerPackageBytes).toBeLessThanOrEqual(
          4 * 1048576,
        );
        if (got!.results.length) {
          const last = got!.results.at(-1)!;
          const after = { score: last.score, doc: last.doc };
          const expectedNext = await control.search(
              q,
              new Reader(before, original.source),
              { ...options, after },
            ),
            next = await executePackets(
              ast,
              terms,
              root,
              new Reader(root, objects.source),
              { ...options, after },
              pkgs,
              plan,
            );
          expect(next!.total).toBe(expectedNext.total);
          expect(next!.results.map((h) => h.id)).toEqual(
            expectedNext.results.map((h) => h.id),
          );
        }
      }
    }
    for (const q of [
      "alpha",
      "rare alpha",
      '"rare alpha"',
      'rare NOT "beta gamma"',
      '"alpha alpha"',
      '"alpha beta"',
      "alpha /2 beta",
      'NOT "alpha beta"',
      "alpha OR NOT beta",
      "rare OR delta",
      "NOT absent",
      "rare /1 beta",
      'NOT NOT "alpha beta"',
    ])
      for (const field of ["all", "body", "title"] as const) {
        const options: Options = {
            limit: 7,
            field,
            titleBoost: field === "title" ? 0 : 3.25,
            exactTotal: true,
          },
          expected = await control.search(
            q,
            new Reader(before, original.source),
            options,
          );
        const independent = docs
          .filter((d) =>
            exhaustive(
              parse(q),
              field === "all"
                ? [tokenize(d.body), tokenize(d.title)]
                : [tokenize(d[field])],
            ),
          )
          .map((d) => d.id)
          .sort();
        expect(expected.total, q + field).toBe(independent.length);
        for (const engine of [complete, candidate]) {
          const got = await engine.search(
            q,
            new Reader(root, objects.source),
            options,
          );
          executors.add(got.diagnostics.executor);
          expect(got.total, q + field).toBe(independent.length);
          expect(
            got.results.map((r) => r.id),
            q + field,
          ).toEqual(expected.results.map((r) => r.id));
          for (let i = 0; i < got.results.length; i++)
            expect(got.results[i].score).toBeCloseTo(
              expected.results[i].score,
              11,
            );
          if (got.results.length) {
            const last = got.results.at(-1)!,
              after = await engine.search(q, new Reader(root, objects.source), {
                ...options,
                after: { doc: last.doc, score: last.score },
              }),
              want = await control.search(
                q,
                new Reader(before, original.source),
                { ...options, after: { doc: last.doc, score: last.score } },
              );
            expect(
              after.results.map((r) => r.id),
              q + field + " cursor",
            ).toEqual(want.results.map((r) => r.id));
          }
        }
      }
    // Independent reference: enumerate the unfiltered ranking completely, then
    // apply metadata to that full list. Never filter an already truncated top-K.
    for (const q of [
      "alpha OR beta",
      "rare alpha",
      '"alpha beta"',
      'NOT "alpha beta"',
      'alpha AND NOT "rare alpha"',
    ]) {
      const all: { doc: number; id: string; score: number }[] = [];
      let after: Options["after"];
      for (;;) {
        const page = await control.search(
          q,
          new Reader(before, original.source),
          { limit: 100, after, metadata: false, snippets: false },
        );
        all.push(...page.results);
        if (page.results.length < 100) break;
        const last = page.results.at(-1)!;
        after = { doc: last.doc, score: last.score };
      }
      const allowed = (doc: number) => doc > 100 && doc % 7 === 2;
      const expected = all.filter((h) => allowed(h.doc)),
        ast = parse(q),
        terms = await directory.lookup(queryTerms(ast));
      const documentFilter = { prepare: async () => allowed };
      for (const strategy of [
        "blocks",
        "complete-terms",
        "documents",
      ] as const) {
        const run = async (opts: Options) =>
          strategy === "blocks"
            ? control.search(q, new Reader(before, original!.source), opts)
            : executePackets(
                ast,
                terms,
                root,
                new Reader(root, objects!.source),
                opts,
                candidate.packages,
                strategy === "documents"
                  ? {
                      ...packetPlan(
                        ast,
                        terms,
                        root,
                        opts,
                        candidate.packages,
                        "documents",
                      ),
                      kind: "documents",
                      membershipAnchor: membership,
                    }
                  : strategy,
              );
        for (const exactTotal of [false, true]) {
          const options: Options = {
            limit: 7,
            documentFilter,
            exactTotal,
            metadata: false,
            snippets: false,
          };
          const got = (await run(options))!;
          expect(
            got.results.map((h) => h.id),
            q + strategy,
          ).toEqual(expected.slice(0, 7).map((h) => h.id));
          if (exactTotal) expect(got.total).toBe(expected.length);
          got.results.forEach((h, i) =>
            expect(h.score).toBeCloseTo(expected[i].score, 11),
          );
          const last = got.results.at(-1);
          if (last) {
            const next = (await run({
              ...options,
              after: { doc: last.doc, score: last.score },
            }))!;
            expect(next.results.map((h) => h.id)).toEqual(
              expected.slice(7, 14).map((h) => h.id),
            );
          }
          expect(got.diagnostics.metadataFilterRejected).toBeGreaterThan(0);
        }
      }
    }
    expect(executors.has("complete-terms")).toBe(true);
    expect(executors.has("documents")).toBe(true);
    const a = ids.get("alpha")!,
      b = ids.get("beta")!,
      rows: PairRow[] = [];
    docs.forEach((d, doc) => {
      const fields = [d.body, d.title].map((text) =>
          tokenize(text).map((word) => ids.get(word)!),
        ),
        occurrences = fields.map((tokens) =>
          tokens.flatMap((id, p) =>
            id === a && tokens[p + 1] === b
              ? [{ position: p, previous: tokens[p - 1], next: tokens[p + 2] }]
              : [],
          ),
        );
      if (occurrences.some((a) => a.length))
        rows.push({ doc, body: occurrences[0], title: occurrences[1] });
    });
    const pairWriter = new Packer(dir + "/index/packs", {
        next: root.objects.length,
        objects: root.objects,
      }),
      pairRef = pairWriter.put(encodePairPacket(a, b, rows));
    pairWriter.flush();
    root.positionalPairs = {
      [`${a}:${b}`]: {
        a,
        b,
        df: rows.length,
        occurrences: rows.reduce(
          (n, r) => n + r.body.length + r.title.length,
          0,
        ),
        ref: pairRef,
      },
    };
    const lookupWriter = new Packer(dir + "/index/packs", {
        next: root.objects.length,
        objects: root.objects,
      }),
      lookupRef = lookupWriter.put(
        encodePairDirectory([
          {
            pair: root.positionalPairs[`${a}:${b}`],
            inline: encodePairPacket(a, b, rows),
          },
        ]),
      );
    lookupWriter.flush();
    const remoteRoot: Root = {
        ...root,
        positionalPairs: undefined,
        pairDirectory: {
          pairs: 1,
          shards: [{ first: [a, b], last: [a, b], ref: lookupRef }],
        },
      },
      remote = new ColumnarIndex(remoteRoot, undefined, directory, {
        averageBytes: 500,
        async load(doc) {
          return new DocumentPackage(packages.get(doc)!, doc);
        },
      });
    await objects.close();
    objects = new OfflineObjects(dir + "/index", root);
    for (const q of [
      '"alpha beta"',
      '"alpha beta gamma"',
      '"alpha beta" AND NOT "beta gamma"',
      '("alpha beta" AND rare) OR ("alpha beta" AND gamma)',
      'NOT "alpha beta"',
    ])
      for (const field of ["all", "body", "title"] as const) {
        const options: Options = {
            field,
            exactTotal: true,
            limit: 7,
            titleBoost: 3.25,
          },
          expected = await control.search(
            q,
            new Reader(before, original.source),
            options,
          ),
          got = await remote.search(
            q,
            new Reader(remoteRoot, objects.source),
            options,
          );
        expect(got.total, q + field).toBe(expected.total);
        expect(got.results, q + field).toEqual(expected.results);
        if (q === '"alpha beta"')
          expect(got.diagnostics.pairDirectoryMatches).toBe(1);
        expect(remoteRoot.positionalPairs).toBeUndefined();
      }
    // The block executor must retain positional pair evidence even when a
    // complete read or candidate-package strategy does not fit its budget.
    const blocked = new ColumnarIndex(root);
    for (const q of [
      '"alpha beta"',
      '"alpha beta gamma"',
      '"alpha beta" AND NOT "beta gamma"',
      '("alpha beta" AND rare) OR ("alpha beta" AND gamma)',
    ])
      for (const field of ["all", "body", "title"] as const) {
        const options: Options = { field, exactTotal: true, limit: 7 },
          expected = await control.search(
            q,
            new Reader(before, original.source),
            options,
          ),
          got = await blocked.search(
            q,
            new Reader(root, objects.source),
            options,
          );
        expect(got.total, q + field).toBe(expected.total);
        expect(
          got.results.map((h) => h.id),
          q + field,
        ).toEqual(expected.results.map((h) => h.id));
        for (let i = 0; i < got.results.length; i++) {
          expect(got.results[i].score, q + field).toBeCloseTo(
            expected.results[i].score,
            11,
          );
          expect(got.results[i].snippet, q + field).toBe(
            expected.results[i].snippet,
          );
        }
        if (q === '"alpha beta"' && field !== "title") {
          expect(got.diagnostics.pairContextIntegers).toBeGreaterThan(0);
          expect(got.diagnostics.pairContextIntegers).toBe(
            2 * got.diagnostics.positionIntegers,
          );
        }
      }
    for (const q of [
      '"alpha beta"',
      '"alpha beta" AND gamma',
      '("alpha beta" AND rare) OR ("alpha beta" AND gamma)',
    ]) {
      const ast = parse(q),
        terms = await directory.lookup(queryTerms(ast)),
        options: Options = { limit: 7, exactTotal: true },
        expected = await control.search(
          q,
          new Reader(before, original.source),
          options,
        ),
        plan = packetPlan(
          ast,
          terms,
          root,
          options,
          {
            averageBytes: 500,
            load: async () => {
              throw Error("not called");
            },
          },
          "documents",
        ),
        got = await executePackets(
          ast,
          terms,
          root,
          new Reader(root, objects.source),
          options,
          {
            averageBytes: 500,
            async load(doc) {
              const pkg = new DocumentPackage(packages.get(doc)!, doc);
              if (plan.pairAnchors)
                pkg.positions = () => {
                  throw Error("Pair context already proves this phrase");
                };
              return pkg;
            },
          },
          "documents",
        );
      if (q === '"alpha beta"')
        expect(got?.diagnostics.plan.pairAnchors?.length, q).toBe(1);
      expect(got?.total, q).toBe(expected.total);
      expect(
        got?.results.map((h) => h.id),
        q,
      ).toEqual(expected.results.map((h) => h.id));
      for (let i = 0; i < expected.results.length; i++)
        expect(got!.results[i].score, q).toBeCloseTo(
          expected.results[i].score,
          11,
        );
    }
    // A complete authoritative packet includes every observed ordered pair.
    // Exercise absent pairs, field separation, OR/NOT safety, common-anchor
    // exclusions and candidate-preserving fallback against the same reference.
    const allPairs = new Map<
      string,
      { a: string; b: string; rows: PairRow[] }
    >();
    docs.forEach((d, doc) => {
      const perDoc = new Map<
        string,
        { a: string; b: string; body: PairRow["body"]; title: PairRow["title"] }
      >();
      for (const field of ["body", "title"] as const) {
        const tokens = tokenize(d[field]);
        for (let p = 0; p + 1 < tokens.length; p++) {
          const a = tokens[p],
            b = tokens[p + 1],
            key = a + "\0" + b;
          let entry = perDoc.get(key);
          if (!entry) {
            entry = { a, b, body: [], title: [] };
            perDoc.set(key, entry);
          }
          entry[field].push({
            position: p,
            previous: ids.get(tokens[p - 1]),
            next: ids.get(tokens[p + 2]),
          });
        }
      }
      for (const [key, entry] of perDoc) {
        let pair = allPairs.get(key);
        if (!pair) {
          pair = { a: entry.a, b: entry.b, rows: [] };
          allPairs.set(key, pair);
        }
        pair.rows.push({ doc, body: entry.body, title: entry.title });
      }
    });
    const orderedPairs = [...allPairs.values()].sort(
        (a, b) =>
          b.rows.length - a.rows.length ||
          a.a.localeCompare(b.a) ||
          a.b.localeCompare(b.b),
      ),
      packetEntries = orderedPairs.map((p) => {
        const context = encodePairPacket(ids.get(p.a)!, ids.get(p.b)!, p.rows),
          data = encodePairMembership(
            {
              a: ids.get(p.a)!,
              b: ids.get(p.b)!,
              df: p.rows.length,
              body: Uint32Array.from(
                p.rows.filter((r) => r.body.length),
                (r) => r.doc,
              ),
              title: Uint32Array.from(
                p.rows.filter((r) => r.title.length),
                (r) => r.doc,
              ),
              bodyOccurrences: p.rows.reduce((n, r) => n + r.body.length, 0),
              titleOccurrences: p.rows.reduce((n, r) => n + r.title.length, 0),
              context: context.length < 4096 ? context : undefined,
            },
            root.count,
          );
        return { a: p.a, b: p.b, data };
      }),
      membershipPacket = encodePairMembershipPacket(packetEntries),
      membershipRoot = {
        ...root,
        positionalPairs: undefined,
        pairDirectory: undefined,
      },
      router = new PairRouter(
        encodePairRouter(
          {
            generation: "a".repeat(64),
            baseGeneration: root.generation,
            documents: root.count,
            targetBytes: 131072,
            contextBytes: 8192,
            namespaces: [],
            roots: [-1],
            commonWords: terms
              .map(([word, t]) => ({ word, id: t.id, df: t.df }))
              .sort((a, b) => b.df - a.df || a.id - b.id),
          },
          [],
          [
            {
              object: 0,
              offset: 0,
              namespace: 0,
              bits: 0,
              prefix: 0,
              bytes: membershipPacket.length,
              crc32: crc32(membershipPacket),
              pairs: allPairs.size,
            },
          ],
          encodePairMembershipPacket(
            orderedPairs.map((p, rank) => ({
              a: p.a,
              b: p.b,
              data: new Uint8Array(
                Uint32Array.from([
                  p.rows.length,
                  p.rows.filter((r) => r.body.length).length,
                  p.rows.filter((r) => r.title.length).length,
                  packetEntries[rank].data.length,
                  rank + 1,
                ]).buffer,
              ),
            })),
          ),
        ),
      );
    const presence = router.metadata.commonWords.map((word) => {
        const body: number[] = [],
          title: number[] = [];
        let bodyOccurrences = 0,
          titleOccurrences = 0;
        docs.forEach((d, doc) => {
          for (const field of ["body", "title"] as const) {
            const n = tokenize(d[field]).filter((t) => t === word.word).length;
            if (n) (field === "body" ? body : title).push(doc);
            if (field === "body") bodyOccurrences += n;
            else titleOccurrences += n;
          }
        });
        return encodePairMembership(
          {
            a: word.id,
            b: word.id,
            df: word.df,
            body: Uint32Array.from(body),
            title: Uint32Array.from(title),
            bodyOccurrences,
            titleOccurrences,
          },
          root.count,
        );
      }),
      presenceMetadata = {
        generation: router.metadata.generation,
        entries: presence.map((data) => ({
          bytes: data.length,
          crc32: crc32(data),
        })),
      };
    for (const averageBytes of [500, 50000])
      for (const [N, M] of [
        [0, 0],
        [2, 1],
        [200, 2000],
      ]) {
        const engine = new ColumnarIndex(
            membershipRoot,
            undefined,
            directory,
            {
              averageBytes,
              load: async (doc) => new DocumentPackage(packages.get(doc)!, doc),
            },
            undefined,
            { router, N, M, presence: presenceMetadata },
          ),
          source = {
            ...objects.source,
            readNamed: async (key: string) =>
              key.includes("/presence-")
                ? presence[Number(key.split("/presence-")[1].split(".")[0])]
                : membershipPacket,
          };
        for (const q of [
          '"alpha beta"',
          '"alpha beta gamma"',
          '"alpha alpha"',
          '"rare alpha"',
          '"alpha beta" AND NOT "beta gamma"',
          '("alpha beta" AND rare) OR ("alpha beta" AND gamma)',
          'NOT "alpha beta"',
          '"alpha beta" OR rare',
          '"alpha beta" AND ("beta gamma" OR "rare alpha")',
          '"alpha beta" OR "rare alpha"',
          '"alpha beta" /3 ("beta gamma" OR "rare alpha")',
          '"alpha beta" AND ("beta gamma" OR rare)',
          '"alpha beta" AND NOT ("beta gamma" OR "rare alpha")',
          'NOT NOT ("alpha beta" OR "rare alpha")',
          '("alpha beta" OR "beta gamma") AND ("rare alpha" OR "gamma alpha")',
          "rare AND alpha",
          "alpha OR beta",
          '"alpha beta" /2 gamma',
        ])
          for (const field of ["all", "body", "title"] as const) {
            const options: Options = {
                limit: 7,
                field,
                exactTotal: true,
                titleBoost: 0,
              },
              expected = await control.search(
                q,
                new Reader(before, original.source),
                options,
              ),
              got = await engine.search(
                q,
                new Reader(membershipRoot, source),
                options,
              );
            expect(got.total, `${q} ${field} N${N} M${M}`).toBe(expected.total);
            expect(got.results.map((h) => h.id)).toEqual(
              expected.results.map((h) => h.id),
            );
            got.results.forEach((h, i) =>
              expect(h.score).toBeCloseTo(expected.results[i].score, 11),
            );
          }
      }
  } finally {
    await original?.close();
    await objects?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
