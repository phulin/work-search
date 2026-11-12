import { readFile, open } from "node:fs/promises";
import { ColumnarIndex } from "./control/search.js";
import { Memory, Reader } from "./control/storage.js";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
const [out, oraclePath] = process.argv.slice(2);
if (!out || !oraclePath)
  throw Error(
    "Usage: yarn node --import tsx bench/rust-builder/verify.ts BUILD_DIR ORACLE.json",
  );
const root = JSON.parse(await readFile(out + "/root.json", "utf8")),
  oracle = JSON.parse(await readFile(oraclePath, "utf8"));
const index = new ColumnarIndex(root),
  memory = new Memory();
const source = {
  async read(key: string, offset: number, length: number) {
    const f = await open(out + "/packs/" + key.split("/").at(-1), "r");
    try {
      const b = Buffer.allocUnsafe(length);
      const r = await f.read(b, 0, length, offset);
      if (r.bytesRead !== length) throw Error("Truncated page");
      return b;
    } finally {
      await f.close();
    }
  },
};
const queries = [
  ...demoWorkload,
  ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
];
let count = 0;
for (const { q } of queries) {
  const got = await index.search(q, new Reader(root, source, memory));
  const want = oracle[q];
  if (!want) throw Error("Missing oracle: " + q);
  if (got.results.length !== want.length) throw Error("Length mismatch: " + q);
  got.results.forEach((h, i) => {
    const w = want[i];
    if (
      h.id !== w.id ||
      Math.abs(h.score - w.score) > 1e-11 * Math.max(1, Math.abs(w.score)) ||
      JSON.stringify([h.title, h.metadata]) !==
        JSON.stringify([w.title, w.metadata])
    )
      throw Error(
        "Oracle mismatch: " + q + " at " + i + ": " + h.id + " vs " + w.id,
      );
    if (!h.snippet && w.id) throw Error("Missing snippet: " + q);
  });
  count++;
  console.log(
    JSON.stringify({
      q,
      matched: got.results.length,
      wallMs: got.diagnostics.wallMs,
    }),
  );
}
console.log(
  JSON.stringify({
    verifiedQueries: count,
    documents: root.count,
    generation: root.generation,
  }),
);
