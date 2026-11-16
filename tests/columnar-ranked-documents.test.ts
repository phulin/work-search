import { expect, it } from "vitest";
import { rankDocumentCandidates } from "../src/columnar/ranked-documents.js";
import { Reader } from "../src/columnar/storage.js";
import type { Root } from "../src/columnar/format.js";

it("preserves a one-shot stream in full when it exceeds the scoring workspace", async () => {
  const root = { count: 1000000 } as Root,
    reader = new Reader(root, {
      read: async () => {
        throw Error("No score I/O for an ineligible plan");
      },
    }),
    input = (function* () {
      for (let i = 0; i < 300000; i++) yield i;
    })(),
    result = await rankDocumentCandidates(
      input,
      { kind: "term", term: "a" },
      new Map(),
      root,
      reader,
      {},
    );
  expect(result.ranked).toBeUndefined();
  let count = 0,
    ordered = true;
  for (const doc of result.candidates) {
    ordered &&= doc === count;
    count++;
  }
  expect(ordered).toBe(true);
  expect(count).toBe(300000);
  expect(reader.stats.requests).toBe(0);
});
