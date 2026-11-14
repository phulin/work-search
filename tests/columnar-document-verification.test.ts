import { expect, it } from "vitest";
import {
  DocumentPackage,
  encodeDocumentPackage,
  documentPrefix,
  encodeDocumentParts,
} from "../src/columnar/document-package.js";
import { encodeTextChunks } from "../src/columnar/text-chunks.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import { view } from "../src/columnar/format.js";
it("finishes a small winner in one read while keeping rejected candidates text-free", async () => {
  const bytes = await encodeDocumentPackage(
      { doc: 0, id: "small", body: "alpha beta ".repeat(500) },
      new Map([
        ["alpha", 0],
        ["beta", 1],
      ]),
    ),
    generation = "a".repeat(64),
    reads: number[] = [],
    makeReader = () =>
      new Reader(
        { generation, objects: [] },
        {
          read: async () => {
            throw Error("Unexpected posting read");
          },
          readWhole: async () => {
            throw Error("Unexpected whole-object read");
          },
          readNamed: async (address, n) => {
            const at = Number(address.split("@")[1]);
            reads.push(n);
            return bytes.slice(at, at + n);
          },
        },
        new Memory(),
      ),
    locator = {
      key: generation + "/plan-0.bin",
      offset: 0,
      length: bytes.length,
      first: 0,
      prefixLength: documentPrefix(bytes),
    },
    wanted = new Set([0]),
    candidateReader = makeReader(),
    candidate = await candidateReader.document(generation, 0, locator, wanted);
  expect(reads).toEqual([documentPrefix(bytes)]);
  expect(candidateReader.stats.documentPresentationBytes).toBe(0);
  expect([...candidate.positions(wanted, 0).get(0)!]).toHaveLength(500);
  reads.length = 0;
  const winnerReader = makeReader(),
    winner = await winnerReader.document(generation, 0, locator, wanted, true),
    full = new DocumentPackage(bytes, 0);
  await winner.preparePresentation();
  expect(await winner.display()).toEqual(await full.display());
  expect(await winner.snippet(wanted)).toEqual(await full.snippet(wanted));
  expect(reads).toEqual([bytes.length]);
  expect(winnerReader.stats.documentVerificationBytes).toBe(
    documentPrefix(bytes),
  );
  expect(winnerReader.stats.documentPresentationBytes).toBe(
    bytes.length - documentPrefix(bytes),
  );
});

it("coalesces small winner presentation sections without changing rendering", async () => {
  const bytes = await encodeDocumentPackage(
      {
        doc: 2,
        id: "small",
        body: "alpha beta ".repeat(500),
        metadata: { court: "test" },
      },
      new Map([
        ["alpha", 0],
        ["beta", 1],
      ]),
    ),
    v = view(bytes),
    reads: number[][] = [],
    selected = new DocumentPackage(
      bytes.subarray(0, documentPrefix(bytes)),
      2,
      undefined,
      async (at, n) => {
        reads.push([at, n]);
        return bytes.subarray(at, at + n);
      },
    ),
    full = new DocumentPackage(bytes, 2);
  await selected.preparePresentation();
  expect(reads).toEqual([
    [v.getUint32(32, true), bytes.length - v.getUint32(32, true)],
  ]);
  const before = reads.length;
  expect(await selected.display()).toEqual(await full.display());
  expect(await selected.snippet(new Set([0]), 0)).toEqual(
    await full.snippet(new Set([0]), 0),
  );
  expect(reads).toHaveLength(before);
});

it("verifies candidates without fetching metadata or passages, then fetches only the winner's relevant passages", async () => {
  const body =
      "filler ".repeat(12000) + "alpha beta needle " + "filler ".repeat(12000),
    ids = new Map([
      ["filler", 0],
      ["alpha", 1],
      ["beta", 2],
      ["needle", 3],
    ]),
    bytes = await encodeDocumentPackage(
      {
        doc: 0,
        id: "winner",
        body,
        metadata: { large: "random metadata ".repeat(10000) },
      },
      ids,
    ),
    v = view(bytes),
    reads: { at: number; n: number }[] = [],
    generation = "a".repeat(64),
    key = generation + "/plan-0.bin",
    reader = new Reader(
      { generation, objects: [] },
      {
        read: async () => {
          throw Error("Unexpected posting read");
        },
        readWhole: async () => {
          throw Error("Whole document transfer");
        },
        readNamed: async (address, n) => {
          const at = Number(address.split("@")[1]);
          reads.push({ at, n });
          return bytes.slice(at, at + n);
        },
      },
      new Memory(),
    ),
    selected = await reader.document(
      generation,
      0,
      {
        key,
        offset: 0,
        length: bytes.length,
        first: 0,
        prefixLength: documentPrefix(bytes),
      },
      new Set([1, 2, 3]),
    );
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((r) => r.at + r.n <= v.getUint32(16, true))).toBe(true);
  expect([...selected.positions(new Set([3]), 0).get(3)!]).toEqual([12002]);
  expect(reader.stats.forwardIntegers).toBe(0);
  const before = reads.length,
    full = new DocumentPackage(bytes, 0);
  expect(await selected.snippet(new Set([3]))).toBe(
    await full.snippet(new Set([3])),
  );
  expect(reads.slice(before).every((r) => r.at >= v.getUint32(40, true))).toBe(
    true,
  );
  expect(
    reads
      .filter((r) => r.at >= v.getUint32(48, true))
      .reduce((n, r) => n + r.n, 0),
  ).toBeLessThan(v.getUint32(52, true));
  expect((await selected.display()).id).toBe("winner");
});

it("directly addresses rare positions in long documents at each stable chunk size without expanding other terms", async () => {
  const tokens = Uint32Array.from({ length: 30000 }, (_, i) => i),
    text = await encodeTextChunks("", []),
    display = new Uint8Array([1]);
  for (const chunk of [16384, 32768, 65536]) {
    const bytes = encodeDocumentParts(
        {
          doc: 9,
          body: tokens,
          title: [],
          display,
          directory: text.directory,
          text: text.data,
        },
        chunk,
      ),
      v = view(bytes),
      reads: { at: number; n: number }[] = [],
      selected = new DocumentPackage(
        bytes.subarray(0, documentPrefix(bytes, chunk)),
        9,
        undefined,
        async (at, n) => {
          reads.push({ at, n });
          return bytes.slice(at, at + n);
        },
      );
    await selected.prepare(new Set([100, 29900]));
    expect(
      [...selected.positions(new Set([100, 29900]), 0)].map(([id, p]) => [
        id,
        ...p,
      ]),
    ).toEqual([
      [100, 100],
      [29900, 29900],
    ]);
    expect(selected.numericBytes).toBeLessThan(5000);
    expect(
      reads.every((r) => r.at + r.n <= v.getUint32(16, true) && r.n <= chunk),
    ).toBe(true);
    expect(selected.rawBytes).toBeLessThan(v.getUint32(16, true) / 2);
    const retained = selected.retain();
    expect(retained.numericBytes).toBe(0);
    await retained.prepare(new Set([100]));
    expect([...retained.positions(new Set([100]), 0).get(100)!]).toEqual([100]);
  }
});
