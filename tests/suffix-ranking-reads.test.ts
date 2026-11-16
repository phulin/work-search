import { expect, it } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeRankingHeads } from "../src/suffix/ranking-heads.js";
import { SuffixReader } from "../src/suffix/reader.js";
import { rankSuffix } from "../src/suffix/rank.js";
import {
  canonicalBit,
  quantize,
  quantizerForMaximum,
  type SuffixManifest,
  type SuffixBlock,
  type SuffixColumn,
} from "../src/suffix/format.js";
import { encodeSuffixKeys } from "../src/suffix/keys.js";

function fixture() {
  const files = new Map<string, Buffer>(),
    scores: number[] = [],
    blocks: SuffixBlock[] = [],
    manifest: SuffixManifest = {
      format: "word-suffix-1",
      generation: "a".repeat(64),
      corpusGeneration: "b".repeat(64),
      count: 2200,
      rows: 2200,
      fixed: { titleBoost: 2, avgBody: 3, avgTitle: 0 },
      directory: [],
      files: {},
    },
    put = (file: string, raw: Uint8Array) => {
      const data = gzipSync(raw),
        old = files.get(file) ?? Buffer.alloc(0);
      files.set(file, Buffer.concat([old, data]));
      return { offset: old.length, length: data.length };
    };
  for (let group = 0; group < 3; group++) {
    const count = group ? 100 : 2000,
      first = scores.length,
      maximum = group ? 2 : 10.02,
      docs = new Uint32Array(count),
      positions = new Uint32Array(count),
      flags = new Uint16Array(count),
      s16 = new Uint16Array(count),
      s8 = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      docs[i] = first + i;
      positions[i] = 0;
      flags[i] = canonicalBit(2, "all") | canonicalBit(2, "body");
      const score = group ? 2 - i / 100 : 10.02 - i / 100000;
      scores.push(score);
      s16[i] = quantize(score, quantizerForMaximum(maximum, 16));
      s8[i] = quantize(score, quantizerForMaximum(maximum, 8));
    }
    const block: SuffixBlock = {
      first,
      count,
      low: [1, 2],
      high: [1, 2],
      scoreMaximum: [maximum, 0, 0, 0],
      minDocument: first,
      columns: {
        documents: put("documents", new Uint8Array(docs.buffer)),
        positions: put("positions", new Uint8Array(positions.buffer)),
        offsets: put("offsets", new Uint8Array(positions.buffer)),
        flags: put("flags", new Uint8Array(flags.buffer)),
        keys: put(
          "keys",
          encodeSuffixKeys(Uint32Array.of(1, 2, 0), new Uint32Array(count)),
        ),
        "score16-2": put("score16-2", new Uint8Array(s16.buffer)),
        "score8-2": put("score8-2", s8),
      } as Record<SuffixColumn, { offset: number; length: number }>,
    };
    blocks.push(block);
    manifest.directory.push({
      low: [1, 2],
      high: [1, 2],
      first,
      end: first + count,
      ref: put("directory", Buffer.from(JSON.stringify([block]))),
      scoreMaximum: block.scoreMaximum,
      minDocument: first,
    });
  }
  const reads: { file: string; at: number; n: number }[] = [],
    reader = new SuffixReader(manifest, async (file, at, n) => {
      reads.push({ file, at, n });
      return files.get(file)!.subarray(at, at + n);
    });
  function installHeads() {
    for (const [i, b] of blocks.entries()) {
      const raw = (name: SuffixColumn) => {
          const r = b.columns[name];
          return gunzipSync(
            files.get(name)!.subarray(r.offset, r.offset + r.length),
          );
        },
        d = raw("documents"),
        p = raw("positions"),
        f = raw("flags"),
        s = raw("score16-2"),
        arrays = [
          new Uint16Array(s.buffer, s.byteOffset, s.length / 2),
          ...Array.from({ length: 3 }, () => new Uint16Array(b.count)),
        ];
      for (let n = 3; n <= 5; n++)
        for (const bits of [8, 16])
          b.columns[`score${bits}-${n}` as SuffixColumn] =
            b.columns[`score${bits}-2` as SuffixColumn];
      const packets = encodeRankingHeads(
        [b],
        new Uint32Array(d.buffer, d.byteOffset, d.length / 4),
        new Uint32Array(p.buffer, p.byteOffset, p.length / 4),
        new Uint16Array(f.buffer, f.byteOffset, f.length / 2),
        arrays,
      );
      manifest.directory[i].ranking = { 2: put("ranking", packets[0]) };
    }
  }
  return { reader, scores, blocks, reads, installHeads };
}

it("finishes from ranking summaries when their omitted bounds lose, and falls back completely for a cursor beyond those summaries", async () => {
  for (const bits of [8, 16] as const)
    for (const afterDoc of [undefined, 500]) {
      const { reader, scores, reads, installHeads } = fixture();
      installHeads();
      const result = await rankSuffix(
        reader,
        Uint32Array.of(1, 2),
        {
          bits,
          limit: 10,
          rangeMax: true,
          after:
            afterDoc === undefined
              ? undefined
              : { doc: afterDoc, score: scores[afterDoc] },
        },
        async (docs) => Float64Array.from(docs, (d) => scores[d]),
      );
      const first = afterDoc === undefined ? 0 : afterDoc + 1;
      expect(result.map((r) => r.doc)).toEqual(
        Array.from({ length: 10 }, (_, i) => first + i),
      );
      expect(reader.stats.rankingReads).toBeGreaterThan(0);
      if (afterDoc === undefined) {
        expect(reader.stats.rankingSkippedBlocks).toBeGreaterThan(0);
        expect(
          reads.some(
            (r) =>
              r.file === "documents" ||
              r.file === "positions" ||
              r.file === "flags" ||
              r.file.startsWith("score"),
          ),
        ).toBe(false);
      } else expect(reads.some((r) => r.file.startsWith("score"))).toBe(true);
    }
});

it("rejects low-scoring directory groups before reading their payload and refines 8-bit uncertainty without fetching every document", async () => {
  for (const bits of [8, 16] as const) {
    const { reader, scores, blocks, reads } = fixture(),
      rescored: number[] = [];
    const result = await rankSuffix(
      reader,
      Uint32Array.of(1, 2),
      { bits, limit: 10, rangeMax: true },
      async (docs) => {
        rescored.push(...docs);
        return Float64Array.from(docs, (d) => scores[d]);
      },
    );
    expect(result.map((r) => r.doc)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(result.map((r) => r.score)).toEqual(scores.slice(0, 10));
    expect(rescored.length).toBeLessThan(40);
    expect(reader.stats.skippedGroups).toBe(2);
    const middle = reader.manifest.directory[1].ref;
    expect(
      reads.some((r) => r.file === "directory" && r.at === middle.offset),
    ).toBe(false);
    for (const block of blocks.slice(1))
      expect(
        reads.some(
          (r) =>
            r.file === "documents" && r.at === block.columns.documents.offset,
        ),
      ).toBe(false);
    if (bits === 8) expect(reader.stats.refinedRows).toBeGreaterThan(1000);
  }
});

it("coalesces adjacent compressed columns while preserving each independently decoded result", async () => {
  const { reader, blocks, reads } = fixture(),
    values = await reader.columns(blocks, ["documents", "positions"]);
  expect(reads.filter((r) => r.file === "documents")).toHaveLength(1);
  expect(reads.filter((r) => r.file === "positions")).toHaveLength(1);
  expect(reader.stats.coalescedReads).toBe(2);
  for (const block of blocks) {
    const raw = values.get(block)!.documents,
      v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    expect(v.getUint32(0, true)).toBe(block.first);
    expect(v.getUint32((block.count - 1) * 4, true)).toBe(
      block.first + block.count - 1,
    );
  }
});
