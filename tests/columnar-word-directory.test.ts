import { it, expect } from "vitest";
import {
  encodeWords,
  decodeWords,
  assembleWords,
  WordDirectory,
} from "../src/columnar/word-directory.js";
it("preserves every ordinal and unknown word through bounded Unicode vocabulary blocks", async () => {
  const words = [
      ...Array.from(
        { length: 5000 },
        (_, i) => `term${String(i).padStart(6, "0")}`,
      ),
      "alpha",
      "bébé",
      "βήτα",
      "𐐀unicode",
      "x".repeat(1000),
      "\u0000",
    ].sort(),
    blocks = [];
  for (let i = 0; i < words.length; i += 512) {
    const part = words.slice(i, i + 512),
      raw = encodeWords(part);
    expect(decodeWords(raw)).toEqual(part);
    blocks.push({ first: part[0], count: part.length, data: raw });
  }
  const bytes = assembleWords(blocks),
    directory = new WordDirectory(bytes),
    want = new Map(words.map((word, i) => [word, i + 1]));
  expect(directory.count).toBe(words.length);
  expect(
    await directory.lookup([...words, "absent", "term000001tail"]),
  ).toEqual(want);
  expect(await directory.lookup([...words].reverse())).toEqual(want);
  for (const i of [0, 8, 12, 16, 24, 32]) {
    const bad = bytes.slice();
    bad[i] ^= 255;
    expect(() => new WordDirectory(bad)).toThrow();
  }
  expect(
    () => new WordDirectory(bytes.subarray(0, bytes.length - 1)),
  ).toThrow();
  const raw = encodeWords(["a", "ab", "b"]);
  expect(() => decodeWords(raw.subarray(0, raw.length - 1))).toThrow();
  expect(() => decodeWords(Uint8Array.from([...raw, 0]))).toThrow();
  expect(() => encodeWords(["b", "a"])).toThrow();
  expect(await new WordDirectory(assembleWords([])).lookup(["a"])).toEqual(
    new Map(),
  );
});
