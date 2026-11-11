import { describe, it, expect } from "vitest";
import {
  DocumentTable,
  encodeDocuments,
  type StoredDocument,
} from "../src/format/documents.js";
import { crc32 } from "../src/format/codec.js";
import { BinaryIndex } from "../src/format/index.js";
import { readFile } from "node:fs/promises";
const doc = (id = "a"): StoredDocument => ({
  id,
  body: 0,
  title: 0,
  metaObject: 0,
  metaOffset: 0,
  metaLength: 1,
});
function repairFirstBlock(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    n = v.getUint32(12, true);
  v.setUint32(
    16 + (n + 1) * 4,
    crc32(bytes.subarray(v.getUint32(16, true), v.getUint32(20, true))),
    true,
  );
}
describe("compressed document tables", () => {
  it.each([0, 1, 31, 32, 33, 64, 97, 1001])(
    "round trips %i documents, random accesses and all u32 widths",
    (n) => {
      let state = 17;
      const rand = () =>
        (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
      const documents = Array.from({ length: n }, (_, i) => ({
        ...doc(
          `${"shared-".repeat(i % 3 === 0 ? 40 : 1)}${i % 2 ? "😀" : "😁"}-${i}-東京`,
        ),
        body: i % 7 === 0 ? 0 : rand(),
        title: i % 5 === 0 ? 0xffffffff : rand(),
        metaObject: i % 3 === 0 ? 0xffffffff : i % 17,
        metaOffset: rand() % 1000000,
        metaLength: rand() % 65536,
      }));
      const bytes = encodeDocuments(documents),
        padded = new Uint8Array(bytes.length + 23);
      padded.set(bytes, 17);
      const table = new DocumentTable(
        padded.subarray(17, 17 + bytes.length),
        n,
      );
      for (let i = n - 1; i >= 0; i--) {
        expect(table.document(i)).toEqual(documents[i]);
        expect(table.lengths(i)).toEqual({
          body: documents[i].body,
          title: documents[i].title,
        });
      }
      expect(table.validated.length).toBe(Math.ceil(Math.ceil(n / 32) / 8));
      for (const i of [-1, n, NaN, 1.5])
        expect(() => table.document(i)).toThrow("range");
    },
  );
  it("preserves contiguous pointers, arbitrary gaps and object transitions across restarts", () => {
    const documents = Array.from({ length: 101 }, (_, i) => ({
      ...doc(`doc-${i}`),
      body: 44,
      title: 3,
      metaObject: Math.floor(i / 17),
      metaOffset: (i % 17) * 70,
      metaLength: 70,
    }));
    const table = new DocumentTable(
      encodeDocuments(documents),
      documents.length,
    );
    for (let i = 0; i < documents.length; i++)
      expect(table.document(i)).toEqual(documents[i]);
    expect(table.bytes.length).toBeLessThan(documents.length * 8);
  });
  it("supports empty IDs and repeated IDs at the codec layer without changing bytes", () => {
    const documents = [
      "",
      "same",
      "same",
      "é",
      "ê",
      "👩‍💻",
      "x".repeat(300) + "😀",
      "x".repeat(300) + "😁",
    ].map((id) => doc(id));
    const table = new DocumentTable(
      encodeDocuments(documents),
      documents.length,
    );
    documents.forEach((d, i) => expect(table.document(i)).toEqual(d));
  });
  it("checks directory geometry and verifies block checksums lazily", () => {
    const bytes = encodeDocuments([doc()]);
    expect(() => new DocumentTable(bytes.subarray(0, 10), 1)).toThrow();
    expect(() => new DocumentTable(bytes, 2)).toThrow();
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 1] ^= 1;
    const table = new DocumentTable(corrupt, 1);
    expect(() => table.lengths(0)).toThrow("checksum");
    expect(() => table.document(0)).toThrow("checksum");
    const bad = bytes.slice(),
      v = new DataView(bad.buffer);
    v.setUint32(16, 0, true);
    expect(() => new DocumentTable(bad, 1)).toThrow("table");
  });
  it("rejects invalid widths, prefixes, pointer tags and overflowing length deltas", () => {
    for (const [offset, value, message] of [
      [8, 33, "block"],
      [20, 1, "front-coded"],
      [23, 2, "tag"],
    ] as const) {
      const bytes = encodeDocuments([doc()]),
        v = new DataView(bytes.buffer),
        start = v.getUint32(16, true);
      bytes[start + offset] = value;
      repairFirstBlock(bytes);
      const t = new DocumentTable(bytes, 1);
      expect(() => t.document(0)).toThrow(message);
    }
    const bytes = encodeDocuments([doc("a"), { ...doc("b"), body: 1 }]),
      v = new DataView(bytes.buffer);
    v.setUint32(v.getUint32(16, true), 0xffffffff, true);
    repairFirstBlock(bytes);
    expect(() => new DocumentTable(bytes, 2).lengths(1)).toThrow("integer");
  });
  it("rejects old bundles rather than interpreting fixed-width descriptors as compressed blocks", async () => {
    const bytes = Uint8Array.from(await readFile("data/bundle.bin"));
    new DataView(bytes.buffer).setUint32(4, 1, true);
    expect(() => new BinaryIndex(bytes)).toThrow("version");
  });
  it("keeps predictable document data below seven bytes per document without expanding at read time", () => {
    // A smaller representative slice covers the same restart and delta patterns at low test cost.
    const docs = Array.from({ length: 10000 }, (_, i) => ({
      ...doc(`doc-${i}`),
      body: 44,
      title: 3,
      metaOffset: i * 80,
      metaLength: 80,
    }));
    const bytes = encodeDocuments(docs);
    expect(bytes.length / docs.length).toBeLessThan(7);
    const t = new DocumentTable(bytes, docs.length);
    expect(t.document(9999)).toEqual(docs[9999]);
    expect(t.validated.byteLength).toBe(40);
  });
});
