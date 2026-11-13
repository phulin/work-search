import { expect, it } from "vitest";
import {
  analyze,
  ENGLISH_ANALYSIS,
  tokenizerFor,
} from "../src/query/analysis.js";
import { parse } from "../src/query/parser.js";
import { scanText } from "../src/columnar/construction/text.js";

it("uses English Porter2 for token identities while retaining common words and Unicode token boundaries", () => {
  expect(
    analyze("Running runs runners courts agreed agreeing skies dying"),
  ).toEqual(["run", "run", "runner", "court", "agre", "agre", "sky", "die"]);
  expect(analyze("THE of AND CAFÉ café ＦＯＸ 東京 ١٢ 123")).toEqual([
    "the",
    "of",
    "and",
    "café",
    "café",
    "fox",
    "東京",
    "١٢",
    "123",
  ]);
  expect(tokenizerFor(undefined)("Running courts")).toEqual([
    "running",
    "courts",
  ]);
  expect(() => tokenizerFor("unknown" as any)).toThrow(
    "Unknown index analysis",
  );
});

it("stems exactly once after finding display spans and preserves repeated-token positions", () => {
  const text = "ＲＵＮＮＩＮＧ İSTANBUL runs CAFÉ café 東京";
  const lexical = [...scanText(text).tokens()],
    stemmed = [...scanText(text, ENGLISH_ANALYSIS).tokens()];
  expect(stemmed.map((t) => t.word)).toEqual(analyze(text));
  expect(stemmed.map(({ word: _, ...span }) => span)).toEqual(
    lexical.map(({ word: _, ...span }) => span),
  );
  expect(
    stemmed.slice(0, 4).map((t) => scanText(text).text.slice(t.start, t.end)),
  ).toEqual(["RUNNING", "İ", "STANBUL", "runs"]);
  expect(
    parse('"Running runs" AND courts', "and", tokenizerFor(ENGLISH_ANALYSIS)),
  ).toEqual({
    kind: "and",
    left: { kind: "phrase", terms: ["run", "run"] },
    right: { kind: "term", term: "court" },
  });
});
