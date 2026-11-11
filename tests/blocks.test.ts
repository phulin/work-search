import { it, expect } from "vitest";
import {
  encodeBlocks,
  decodeDirectory,
  directoryLength,
  selectBlocks,
} from "../src/format/blocks.js";
import { loadPosting, requiredTerms } from "../src/query/load.js";
import { parse } from "../src/query/parser.js";
import { crc32, postingPositions, type Posting } from "../src/format/codec.js";
import type { Entry } from "../src/format/index.js";
const rows: Posting[] = Array.from({ length: 4097 }, (_, i) => ({
  doc: i * 3,
  body: 2,
  title: 1,
  bodyPositions: [1, 200],
  titlePositions: [4],
}));
function fixture() {
  const { frequencies, positions, crc } = encodeBlocks(rows);
  const e: Entry = {
    term: "common",
    df: rows.length,
    object: 0,
    offset: 0,
    length: frequencies.length,
    crc,
    positionObject: 0,
    positionOffset: 0,
    positionLength: positions.length,
    positionCrc: crc32(positions),
  };
  const reads: { positions: boolean; offset: number; length: number }[] = [];
  const read = async (_: Entry, p: boolean, offset: number, length: number) => {
    reads.push({ positions: p, offset, length });
    return (p ? positions : frequencies).subarray(offset, offset + length);
  };
  return { e, frequencies, positions, read, reads };
}
it("round trips independently restarted frequency and positional blocks, including a final partial block", async () => {
  const { e, read } = fixture(),
    l = await loadPosting(e, true, read);
  expect([...l.docs]).toEqual(rows.map((p) => p.doc));
  for (const row of [0, 255, 256, 4096]) {
    expect([...postingPositions(l, row).body]).toEqual([1, 200]);
    expect([...postingPositions(l, row).title]).toEqual([4]);
  }
});
it("seeks sparse candidates, reads fewer bytes and never fetches positions for plain terms", async () => {
  const { e, read, reads } = fixture(),
    l = await loadPosting(e, false, read, new Uint32Array([3, 3072]));
  expect(l.docs).toContain(3);
  expect(l.docs).toContain(3072);
  expect(l.docs.length).toBe(512);
  expect(reads.every((r) => !r.positions)).toBe(true);
  expect(reads.reduce((s, r) => s + r.length, 0)).toBeLessThan(e.length / 2);
  const p = await loadPosting(e, true, read, new Uint32Array([3]));
  expect([...postingPositions(p, 1).body]).toEqual([1, 200]);
});
it("bounds fragmented remote reads and handles missing/end-of-list candidates", async () => {
  const { e, read, reads } = fixture();
  await loadPosting(
    e,
    true,
    read,
    new Uint32Array([1, 800, 1600, 2400, 3200, 4000, 4800, 5600, 6400]),
  );
  expect(reads.length).toBeLessThanOrEqual(9);
  expect(
    (await loadPosting(e, false, read, new Uint32Array([0xffffffff]))).docs
      .length,
  ).toBe(0);
  expect(
    (await loadPosting(e, false, read, new Uint32Array())).docs.length,
  ).toBe(0);
});
it("rejects directory and selected block corruption while leaving skipped blocks unread", async () => {
  const f = fixture(),
    len = directoryLength(f.e.df);
  const directory = f.frequencies.subarray(0, len);
  const blocks = decodeDirectory(
    directory,
    f.e.df,
    f.e.length,
    f.e.positionLength,
    f.e.crc,
  );
  expect(selectBlocks(blocks, new Uint32Array([0, 768, 0xffffffff]))).toEqual([
    0, 1,
  ]);
  f.frequencies[blocks[2].offset + 1] ^= 1;
  await expect(
    loadPosting(f.e, false, f.read, new Uint32Array([0])),
  ).resolves.toBeDefined();
  await expect(loadPosting(f.e, false, f.read)).rejects.toThrow("checksum");
  f.frequencies[0] ^= 1;
  await expect(loadPosting(f.e, false, f.read)).rejects.toThrow("directory");
});
it("only selects an anchor that every result must contain", () => {
  for (const [q, terms] of [
    ["rare AND common", ["rare", "common"]],
    ["rare OR common", []],
    ["(rare AND common) OR (rare AND other)", ["rare"]],
    ["rare AND NOT common", ["rare"]],
    ["NOT rare", []],
    ['"rare common"', ["rare", "common"]],
    ["rare /s common", ["rare", "common"]],
  ] as const)
    expect([...requiredTerms(parse(q))].sort()).toEqual([...terms].sort());
});

it("preserves exact Boolean and positional results across sparse and exhaustive plans", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { build } = await import("../src/builder/build.js");
  const { BinaryIndex } = await import("../src/format/index.js");
  const { FileStorage } = await import("../src/storage/filesystem.js");
  const { search } = await import("../src/query/engine.js");
  const root = await mkdtemp(join(tmpdir(), "block-query-"));
  try {
    const docs = Array.from({ length: 2049 }, (_, i) => ({
      id: String(i),
      title: i % 521 ? "common" : "rare common",
      body: "common common " + (i % 257 === 0 ? "rare common" : "other"),
    }));
    await writeFile(
      join(root, "input"),
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    let remoteBudget = 1000000;
    for (const budget of [1000000, 0]) {
      const out = join(root, String(budget));
      const manifest = await build({
        input: join(root, "input"),
        out,
        budget: budget || remoteBudget,
        strategy: "smallest",
      });
      remoteBudget = manifest.bundleBytes - manifest.embeddedBytes;
      const index = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
        store = new FileStorage(join(out, "objects"));
      for (const q of [
        "rare common",
        "rare /s common",
        '"rare common"',
        "(rare AND common) OR (rare AND other)",
        'rare AND NOT "common other"',
        "common OR rare",
        "NOT rare",
        "rare /s (common AND NOT other)",
      ])
        for (const field of ["all", "body", "title"] as const) {
          const a = await search(index, store, q, { field }, false),
            b = await search(index, store, q, { field });
          expect(b.results).toEqual(a.results);
          expect(b.total).toBe(a.total);
        }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("matches the previous decoder for multi-byte gaps, frequencies and positions", async () => {
  const { loadPosting: previous } =
    await import("../bench/baseline-v5-blocks/load.js");
  const records: Posting[] = Array.from({ length: 1031 }, (_, i) => {
    const body = i === 511 ? 130 : 1 + (i % 5),
      title = i % 3;
    return {
      doc: i * 300,
      body,
      title,
      bodyPositions: Array.from({ length: body }, (_, j) => j * 301),
      titlePositions: Array.from({ length: title }, (_, j) => 128 + j * 300),
    };
  });
  const { frequencies, positions, crc } = encodeBlocks(records);
  const e: Entry = {
    term: "x",
    df: records.length,
    object: 0,
    offset: 0,
    length: frequencies.length,
    crc,
    positionObject: 0,
    positionOffset: 0,
    positionLength: positions.length,
    positionCrc: crc32(positions),
  };
  const read = async (_: Entry, p: boolean, start: number, length: number) =>
    (p ? positions : frequencies).subarray(start, start + length);
  for (const candidates of [
    undefined,
    new Uint32Array([0, 90000, 300000]),
    new Uint32Array(),
  ])
    for (const positional of [false, true]) {
      const a = await previous(e, positional, read, candidates),
        b = await loadPosting(e, positional, read, candidates);
      expect(b.docs).toEqual(a.docs);
      expect(b.body).toEqual(a.body);
      expect(b.title).toEqual(a.title);
      if (positional)
        for (let row = 0; row < a.docs.length; row++)
          expect(postingPositions(b, row)).toEqual(postingPositions(a, row));
    }
});

it("validates canonical varints and never reads beyond a selected block", async () => {
  const { decodeBlockInto } = await import("../src/format/decode-block.js");
  const { decodeFrequencies } = await import("../src/format/codec.js");
  for (const bytes of [
    new Uint8Array([0x81, 0]),
    new Uint8Array([1, 0x80]),
    new Uint8Array([1, 0, 0, 0]),
  ]) {
    const padded = new Uint8Array(bytes.length + 20);
    padded.set(bytes);
    const block = {
      first: 0,
      last: 0,
      offset: 0,
      length: bytes.length,
      crc: crc32(bytes),
      count: 1,
      positionOffset: 0,
      positionLength: 1,
      positionCrc: 0,
    };
    const result = {
      docs: new Uint32Array(1),
      body: new Uint32Array(1),
      title: new Uint32Array(1),
      bytes: new Uint8Array(0),
    };
    expect(() => decodeBlockInto(padded, 0, block, result, 0)).toThrow();
  }
  expect(() => decodeFrequencies(new Uint8Array([0x80, 0]))).toThrow(
    "Invalid varint",
  );
  expect(() => decodeFrequencies(new Uint8Array([0x80]))).toThrow("Truncated");
});

it("never caches an empty or partial attachment as complete when its input was complete", async () => {
  const { attachCandidatePositions } = await import("../src/query/load.js");
  const { e, read } = fixture();
  const complete = await loadPosting(e, true, read);
  expect(complete.positionsComplete).toBe(true);
  const empty = await attachCandidatePositions(
    e,
    complete,
    read,
    new Uint32Array(),
  );
  expect(empty.positionsComplete).toBe(false);
  const partial = await attachCandidatePositions(
    e,
    complete,
    read,
    new Uint32Array([0]),
  );
  expect(partial.positionsComplete).toBe(false);
  expect(complete.positionsComplete).toBe(true);
  expect([...postingPositions(complete, 300).body]).toEqual([1, 200]);
});
