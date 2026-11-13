import { expect, it } from "vitest";
import {
  parse,
  simplify,
  positional,
  positionalTerms,
  queryTerms,
} from "../src/query/parser.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
it("treats a single quoted word as membership while preserving its proximity point occurrences", () => {
  const words = ["a", "b", "and", "école"],
    fields: string[][] = [[]];
  for (let code = 0; code < 256; code++) {
    let n = code;
    const tokens = [];
    for (let i = 0; i < 4; i++) {
      tokens.push(words[n % 4]);
      n = Math.floor(n / 4);
    }
    fields.push(tokens);
  }
  for (const q of [
    '"and"',
    'NOT "and"',
    'a OR "and"',
    'a AND NOT "and"',
    '"and" /2 a',
    '("a" OR b) +2 "and"',
    '"école" /3 "and"',
    'NOT ("and" /2 "and")',
  ]) {
    const original = parse(q),
      compact = simplify(original, () => true);
    expect(queryTerms(compact, true)).toEqual(queryTerms(original, true));
    for (let i = 0; i < fields.length; i++) {
      const pair = [fields[i], fields[(i * 17) % fields.length]];
      expect(exhaustive(compact, pair), q + ":" + i).toBe(
        exhaustive(original, pair),
      );
      expect(exhaustive(compact, [pair[0]]), q + ":body:" + i).toBe(
        exhaustive(original, [pair[0]]),
      );
    }
  }
  expect(positional(simplify(parse('"and"'), () => true))).toBe(false);
  expect([
    ...positionalTerms(simplify(parse('"and" /2 a'), () => true)),
  ]).toEqual(["and", "a"]);
  expect(simplify(parse('"and"'), () => false)).toEqual({ kind: "empty" });
});
