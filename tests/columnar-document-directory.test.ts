import { it, expect } from "vitest";
import {
  DocumentDirectory,
  encodeDocumentDirectory,
  pack,
  type DocumentGroup,
} from "../src/columnar/document-directory.js";
it("directly locates every package across irregular physical groups and refuses incomplete coverage", () => {
  let seed = 19;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const groups: DocumentGroup[] = [],
    expected = [];
  let first = 0;
  while (first < 1000) {
    const end = Math.min(1000, first + 1 + (rand() % 128)),
      offsets = [0],
      sha256 = groups.length.toString(16).padStart(64, "0");
    for (let doc = first; doc < end; doc++) {
      const length = 64 + (rand() % 1000000);
      expected.push({
        key: `${sha256}/plan-0.bin`,
        first,
        offset: offsets.at(-1)!,
        length,
      });
      offsets.push(offsets.at(-1)! + length);
    }
    groups.push({ first, end, sha256, offsets: pack(offsets, true) });
    first = end;
  }
  const bytes = encodeDocumentDirectory(groups, 1000),
    directory = new DocumentDirectory(bytes);
  // Deliberately alternate groups to exercise restart lookup rather than merely
  // relying on a sequential decoder cursor.
  for (let doc = 0; doc < 1000; doc++) {
    const id = doc % 2 ? 1000 - (doc + 1) / 2 : doc / 2;
    expect(directory.lookup(id)).toEqual(expected[id]);
  }
  expect(() => directory.lookup(1000)).toThrow();
  expect(
    () => new DocumentDirectory(bytes.subarray(0, bytes.length - 1)),
  ).toThrow();
  expect(() => encodeDocumentDirectory(groups.slice(1), 1000)).toThrow();
  expect(() => encodeDocumentDirectory(groups, 1001)).toThrow();
});
