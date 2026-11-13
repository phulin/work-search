import { it, expect } from "vitest";
import {
  DocumentPackage,
  encodeDocumentPackage,
} from "../src/columnar/document-package.js";
import { tokenize } from "../src/query/tokenize.js";
it("finishes a document from one independently sectioned package, preserving exact statistics, Unicode and relevant snippets", async () => {
  const doc = {
      doc: 123,
      id: "id\ud800",
      title: "İ Alpha title",
      metadata: { x: "\udfff" },
      body:
        "A ".repeat(800) +
        "Ａlpha beta needle\ud800end " +
        "later ".repeat(350),
    },
    body = tokenize(doc.body),
    title = tokenize(doc.title),
    ids = new Map(
      [...new Set([...body, ...title])].sort().map((w, i) => [w, i + 1]),
    ),
    data = await encodeDocumentPackage(doc, ids),
    pkg = new DocumentPackage(data, doc.doc),
    f = pkg.frequencies();
  expect(pkg.bodyLength).toBe(body.length);
  expect(pkg.titleLength).toBe(title.length);
  expect([...pkg.tokens(0)]).toEqual(body.map((w) => ids.get(w)));
  expect([...pkg.tokens(1)]).toEqual(title.map((w) => ids.get(w)));
  for (let i = 0; i < f.ids.length; i++) {
    const word = [...ids].find(([, id]) => id === f.ids[i])![0];
    expect(f.body[i]).toBe(body.filter((w) => w === word).length);
    expect(f.title[i]).toBe(title.filter((w) => w === word).length);
  }
  const wanted = new Set([ids.get("alpha")!, ids.get("needle")!]);
  for (const field of [0, 1]) {
    const p = pkg.positions(wanted, field),
      tokens = field ? title : body;
    for (const id of wanted)
      expect(p.get(id) ?? []).toEqual(
        tokens.flatMap((word, i) => (ids.get(word) === id ? [i] : [])),
      );
  }
  expect(await pkg.display()).toEqual({
    id: doc.id,
    title: doc.title,
    metadata: doc.metadata,
  });
  expect(await pkg.snippet(new Set([ids.get("needle")!]))).toContain(
    "needle\ud800end",
  );
  expect(await pkg.snippet(wanted, 800)).toContain("Alpha beta");
  expect(await pkg.snippet(wanted, undefined, true)).toBe(doc.title);
  expect(() => new DocumentPackage(data, 124)).toThrow("Invalid document");
  const bad = data.slice();
  new DataView(bad.buffer).setUint32(16, 65, true);
  expect(() => new DocumentPackage(bad, 123)).toThrow("section");
  const empty = new DocumentPackage(
    await encodeDocumentPackage({ doc: 0, id: "empty", body: "" }, new Map()),
    0,
  );
  expect(await empty.snippet(new Set())).toBe("");
  expect(empty.frequencies().ids.length).toBe(0);
});
