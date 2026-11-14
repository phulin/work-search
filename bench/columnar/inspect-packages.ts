/** Local-only package sizing at the exact Boolean-membership continuation point. */
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  ColumnarIndex,
  type ContinuationContext,
} from "../../src/columnar/search.js";
import { Reader } from "../../src/columnar/storage.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { PairRouter } from "../../src/columnar/pair-router.js";
import { LocalObjects } from "./local-storage.js";
const [indexDir, pairDir, queriesFile, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "Usage: inspect-packages.ts INDEX PAIRS QUERIES.json OUTPUT.json.gz",
  );
const root = JSON.parse(await readFile(indexDir + "/root.json", "utf8")),
  input = JSON.parse(await readFile(queriesFile, "utf8")),
  queries = input.queries ?? input.scenarios,
  directory = new TermDirectory(
    await readFile(indexDir + "/directory.bin"),
    root.count,
  ),
  documents = new DocumentDirectory(
    await readFile(indexDir + "/documents.bin"),
  ),
  source = new LocalObjects(
    root,
    process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
  );
if (root.count !== 1000000) throw Error("Expected local 1M corpus");
source.namedDirectory = pairDir;
const stats = (sizes: number[]) => {
  const a = [...sizes].sort((a, b) => a - b),
    at = (p: number) => a[Math.max(0, Math.ceil(a.length * p) - 1)] ?? 0;
  return {
    count: a.length,
    bytes: a.reduce((a, b) => a + b, 0),
    min: a[0] ?? 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: a.at(-1) ?? 0,
  };
};
const STOP = new Error("sized continuation");
let captured: any;
class Probe extends ColumnarIndex {
  protected override async chooseContinuation(
    c: ContinuationContext,
  ): Promise<any> {
    const anchor = c.packages?.membership;
    if (!anchor) {
      captured = { membership: false, plan: c.plan };
      throw STOP;
    }
    const ids = Uint32Array.from(
        [...anchor.values()].filter(
          (d) => !c.packages?.presenceFilter || c.packages.presenceFilter(d),
        ),
      ),
      sizes = Array.from(ids, (d) => documents.lookup(d).length),
      largest = Array.from(ids, (doc, i) => ({ doc, bytes: sizes[i] }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5);
    for (const entry of largest) {
      const loc = documents.lookup(entry.doc),
        file = await open(source.dir + "/objects/" + loc.key, "r");
      try {
        const raw = Buffer.alloc(80);
        await file.read(raw, 0, raw.length, loc.offset);
        if (
          raw.readUInt32LE(0) !== 0x33504443 ||
          raw.readUInt32LE(4) !== entry.doc
        )
          throw Error("Package header mismatch");
        Object.assign(entry, {
          bodyTokens: raw.readUInt32LE(8),
          titleTokens: raw.readUInt32LE(12),
          distinctTerms: raw.readUInt32LE(76),
        });
      } finally {
        await file.close();
      }
    }
    captured = {
      membership: true,
      pairCandidates: anchor.count,
      candidates: ids.length,
      candidateSha256: createHash("sha256")
        .update(new Uint8Array(ids.buffer))
        .digest("hex"),
      sizes: stats(sizes),
      largest,
      plan: c.plan,
    };
    throw STOP;
  }
}
const index = new Probe(root, undefined, directory, undefined, documents, {
    router: new PairRouter(await readFile(pairDir + "/router.bin")),
    presence: JSON.parse(await readFile(pairDir + "/presence.json", "utf8")),
    N: 100,
    M: 1000,
  }),
  rows = [];
for (const q of queries) {
  captured = undefined;
  const query = q.query ?? q.q;
  try {
    await index.search(
      query,
      new Reader(root, source),
      q.options ?? {
        mode: "and",
        limit: 20,
        field: "all",
        titleBoost: 2,
        metadata: true,
        snippets: true,
      },
    );
  } catch (e) {
    if (e !== STOP) throw e;
  }
  rows.push({ id: q.brief_id, q: query, ...captured });
}
if (source.downloads) throw Error("Unexpected download");
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      kind: "Direct locator lengths and local header inspection before continuations; no simulated reads or serving measurements.",
      generation: root.generation,
      corpusHash: root.corpusHash,
      analysis: root.analysis,
      documents: root.count,
      N: 100,
      M: 1000,
      rows,
      downloads: source.downloads,
    }),
  ),
);
for (const r of rows
  .filter((r) => r.membership)
  .sort((a, b) => a.candidates - b.candidates))
  console.log(r.candidates, (r.sizes.bytes / 1048576).toFixed(2) + " MiB", r.q);
