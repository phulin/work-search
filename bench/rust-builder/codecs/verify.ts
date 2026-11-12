import { zstdDecompressSync } from "node:zlib";
import type { Ref } from "../control/format.js";
import { readFile, open } from "node:fs/promises";
import { ColumnarIndex } from "../control/search.js";
import { Memory, Reader } from "../control/storage.js";
import { demoWorkload } from "../../demo-workload.js";
import { globalQueries } from "../../global-workload.js";
const [out, oraclePath, baseline] = process.argv.slice(2);
if (!out || !oraclePath)
  throw Error(
    "Usage: yarn node --import tsx bench/rust-builder/verify.ts BUILD_DIR ORACLE.json",
  );
const root = JSON.parse(await readFile(out + "/root.json", "utf8")),
  oracle = JSON.parse(await readFile(oraclePath, "utf8"));
if (root.format !== "CWS1-CODEC-EXPERIMENT")
  throw Error("Expected experimental codec root");
// Reader adapter is benchmark-only: the normal format cannot decode these frames.
root.format = "CWS1";
class ExperimentalReader extends Reader {
  override async json(ref: Ref) {
    const key = "text:" + this.key(ref),
      old = this.memory.decoded.get(key);
    if (old) return old as any;
    const b = await this.read(ref),
      raw = zstdDecompressSync(b, { maxOutputLength: 8 * 1048576 }),
      text = new TextDecoder().decode(raw),
      value = JSON.parse(text);
    this.memory.decoded.set(key, value, text.length * 3);
    return value;
  }
}
const index = new ColumnarIndex(root),
  memory = new Memory();
function sourceFor(dir: string) {
  return {
    async read(key: string, offset: number, length: number) {
      const f = await open(dir + "/packs/" + key.split("/").at(-1), "r");
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
}
const source = sourceFor(out);
const baseRoot = baseline
    ? JSON.parse(await readFile(baseline + "/root.json", "utf8"))
    : null,
  baseIndex = baseRoot ? new ColumnarIndex(baseRoot) : null,
  baseMemory = new Memory();
const queries = [
  ...demoWorkload,
  ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
];
let count = 0;
for (const { q } of queries) {
  const got = await index.search(
    q,
    new ExperimentalReader(root, source, memory),
  );
  if (baseIndex) {
    const expected = await baseIndex.search(
      q,
      new Reader(baseRoot, sourceFor(baseline), baseMemory),
    );
    if (JSON.stringify(got.results) !== JSON.stringify(expected.results))
      throw Error("Gzip full result/snippet mismatch: " + q);
  }
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
    codec: "zstd-1",
    exactGzipResultAndSnippetComparison: !!baseline,
    documents: root.count,
    generation: root.generation,
  }),
);
