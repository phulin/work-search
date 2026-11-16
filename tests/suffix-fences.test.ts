import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { encodeSuffixFences, SuffixFences } from "../src/suffix/fences.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { encodeSuffixKeys, comparePhrase } from "../src/suffix/keys.js";
import type {
  SuffixBlock,
  SuffixManifest,
  SuffixColumn,
} from "../src/suffix/format.js";

it("resolves phrase intervals from bundled fences across repeated prefixes, block edges, absent phrases and short fields", async () => {
  let seed = 3119;
  const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    },
    keys = Array.from({ length: 224 }, () =>
      Array.from({ length: 1 + (random() % 8) }, () => 1 + (random() % 7)),
    );
  keys.sort((a, b) => {
    for (let i = 0; i < 8; i++) {
      const c = (a[i] ?? 0) - (b[i] ?? 0);
      if (c) return c;
    }
    return 0;
  });
  const files = new Map<string, Buffer>(),
    blocks: SuffixBlock[] = [],
    manifest: SuffixManifest = {
      format: "word-suffix-1",
      generation: "a".repeat(64),
      corpusGeneration: "b".repeat(64),
      count: 224,
      rows: 224,
      fixed: { titleBoost: 2, avgBody: 1, avgTitle: 0 },
      directory: [],
      files: {},
    },
    put = (file: string, raw: Uint8Array) => {
      const old = files.get(file) ?? Buffer.alloc(0),
        data = gzipSync(raw);
      files.set(file, Buffer.concat([old, data]));
      return { offset: old.length, length: data.length };
    };
  for (let first = 0; first < keys.length; first += 7) {
    const selected = keys.slice(first, first + 7),
      tokens = Uint32Array.from(selected.flatMap((k) => [...k, 0])),
      offsets = new Uint32Array(selected.length);
    for (let i = 1; i < selected.length; i++)
      offsets[i] = offsets[i - 1] + selected[i - 1].length + 1;
    blocks.push({
      first,
      count: selected.length,
      low: selected[0],
      high: selected.at(-1)!,
      columns: {
        documents: put(
          "documents",
          new Uint8Array(
            Uint32Array.from(selected, (_, i) => first + i).buffer,
          ),
        ),
        positions: put(
          "positions",
          new Uint8Array(new Uint32Array(selected.length).buffer),
        ),
        keys: put("keys", encodeSuffixKeys(tokens, offsets)),
      } as Record<SuffixColumn, { offset: number; length: number }>,
      scoreMaximum: [0, 0, 0, 0],
      minDocument: 0,
    });
  }
  for (let i = 0; i < blocks.length; i += 4) {
    const bs = blocks.slice(i, i + 4);
    manifest.directory.push({
      first: bs[0].first,
      end: bs.at(-1)!.first + bs.at(-1)!.count,
      low: bs[0].low,
      high: bs.at(-1)!.high,
      ref: put("directory", Buffer.from(JSON.stringify(bs))),
    });
  }
  const bytes = encodeSuffixFences(
      blocks,
      manifest.corpusGeneration,
      manifest.rows,
    ),
    reads: string[] = [],
    reader = new SuffixReader(
      manifest,
      async (file, at, n) => {
        reads.push(file);
        return files.get(file)!.subarray(at, at + n);
      },
      bytes,
    ),
    ordinary = new SuffixReader(manifest, async (file, at, n) =>
      files.get(file)!.subarray(at, at + n),
    ),
    queries = [
      [8],
      [7, 7, 7, 7, 7],
      [1, 1, 1, 1, 1],
      ...keys
        .filter((_, i) => i % 7 === 0 || i % 7 === 6)
        .flatMap((k) =>
          Array.from({ length: Math.min(5, k.length) }, (_, i) =>
            k.slice(0, i + 1),
          ),
        ),
    ];
  for (const query of queries) {
    const phrase = Uint32Array.from(query),
      a = await reader.shortInterval(phrase),
      b = await ordinary.shortInterval(phrase),
      matching = keys
        .map((k, i) => (comparePhrase(k, phrase) === 0 ? i : -1))
        .filter((i) => i >= 0);
    if (matching.length) {
      expect([a.first, a.end]).toEqual([b.first, b.end]);
      expect([a.first, a.end]).toEqual([matching[0], matching.at(-1)! + 1]);
      const expanded = await reader.expand(a, ["documents", "positions"]),
        docs: number[] = [];
      for await (const batch of reader.scan(expanded, [
        "documents",
        "positions",
      ])) {
        const data = batch.columns.documents!,
          v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = batch.first; i < batch.end; i++)
          docs.push(v.getUint32(i * 4, true));
      }
      expect(docs).toEqual(matching);
    } else {
      expect(a.end).toBe(a.first);
      expect(b.end).toBe(b.first);
    }
  }
  expect(reads.length).toBeGreaterThan(0);
  expect(reads).not.toContain("directory");
  expect(
    () =>
      new SuffixFences(bytes, {
        ...manifest,
        corpusGeneration: "c".repeat(64),
      }),
  ).toThrow("Invalid suffix fences");
  expect(
    () => new SuffixFences(bytes.subarray(0, bytes.length - 1), manifest),
  ).toThrow("Truncated suffix fences");
  expect(() =>
    encodeSuffixFences(
      [{ ...blocks[0], low: [0x1000000] }],
      manifest.corpusGeneration,
      7,
    ),
  ).toThrow("24 bits");
  const large = blocks.map((b) => ({
    ...b,
    columns: {
      ...b.columns,
      keys: {
        offset: b.columns.keys.offset + 2 ** 36,
        length: b.columns.keys.length,
      },
    },
  }));
  const wide = new SuffixFences(
    encodeSuffixFences(large, manifest.corpusGeneration, manifest.rows),
    manifest,
  );
  expect(
    wide.bounds(Uint32Array.of(3, 4))![0].columns.keys.offset,
  ).toBeGreaterThan(2 ** 32);
});
