import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  encodeSuffixFences,
  SuffixFences,
  SuffixFenceBuilder,
} from "../src/suffix/fences.js";
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
    expect(reader.minimumRows(phrase)).toBeLessThanOrEqual(matching.length);
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

it("preserves wide addresses across restart groups and rejects column gaps", () => {
  const generation = "a".repeat(64),
    offsets = [2 ** 36, 2 ** 34, 2 ** 35],
    blocks = Array.from({ length: 150 }, (_, i) => {
      const lengths = [100 + i, 50 + i, 30 + i],
        columns = {} as SuffixBlock["columns"];
      for (const [j, name] of ["keys", "documents", "positions"].entries()) {
        columns[name as SuffixColumn] = {
          offset: offsets[j],
          length: lengths[j],
        };
        offsets[j] += lengths[j];
      }
      return {
        first: i * 7,
        count: 7,
        low: [i + 1, 1],
        high: [i + 1, 9],
        columns,
        scoreMaximum: [],
        minDocument: 0,
      };
    }),
    raw = encodeSuffixFences(blocks, generation, 1050),
    fences = new SuffixFences(raw, {
      corpusGeneration: generation,
      rows: 1050,
    });
  expect(raw.length).toBeLessThan(48 + 150 * 47);
  for (let i = 0; i < 150; i++) {
    const actual = fences.blocks(i * 7, i * 7 + 7);
    expect(actual).toHaveLength(1);
    expect(actual[0].first).toBe(blocks[i].first);
    expect(actual[0].columns).toEqual(blocks[i].columns);
    expect(fences.bounds(Uint32Array.of(i + 1, 1))![1].columns).toEqual(
      blocks[i].columns,
    );
  }
  const builder = new SuffixFenceBuilder(150, generation, 1050);
  builder.append(blocks.slice(0, 63));
  builder.append(blocks.slice(63, 129));
  builder.append(blocks.slice(129));
  expect(builder.finish()).toEqual(raw);
  const bad = blocks.map((b) => ({ ...b, columns: { ...b.columns } }));
  bad[65].columns.keys = { ...bad[65].columns.keys, offset: 1 };
  expect(() => encodeSuffixFences(bad, generation, 1050)).toThrow(
    "Noncontiguous",
  );
});
