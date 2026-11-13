import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildColumnar } from "../src/columnar/build.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { Reader } from "../src/columnar/storage.js";
import { ColumnarIndex, leaves, type Options } from "../src/columnar/search.js";
import { Packer } from "../src/columnar/packer.js";
import { encodeTermPacket } from "../src/columnar/term-packet.js";
import { decodeScores, type Term, type Root } from "../src/columnar/format.js";
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
import {
  executePackets,
  packetPlan,
} from "../src/columnar/packet-execution.js";
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
          s = decodeScores(scores);
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
    const executors = new Set<string>();
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
    await objects.close();
    objects = new OfflineObjects(dir + "/index", root);
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
  } finally {
    await original?.close();
    await objects?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
