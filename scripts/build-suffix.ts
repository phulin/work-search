import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { benchmarkToken } from "../bench/columnar/token.js";
import { decodeNumeric } from "../src/columnar/construction/numeric-staging.js";
import { decodeSummaries } from "../src/columnar/construction/term-summaries.js";
import type { Chunk } from "../src/columnar/construction/runs.js";
import { buildSuffixIndex } from "./suffix-builder.js";

const [index, output, url] = process.argv.slice(2);
if (!url)
  throw Error("Use COMPLETE_INDEX_DIRECTORY SUFFIX_OUTPUT CONSTRUCTOR_URL");
const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  { catalogue } = JSON.parse(await readFile(index + "/catalogue.json", "utf8")),
  packages = JSON.parse(await readFile(index + "/packages.json", "utf8")),
  token = await benchmarkToken();
if (
  root.count !== catalogue.documents ||
  root.corpusHash !== catalogue.source ||
  !root.pairMembership?.completeContext
)
  throw Error("Suffix source is not the completed corpus");
await mkdir(output + "/cache", { recursive: true });
async function get(ref: Chunk) {
  const path = output + "/cache/" + ref.sha256;
  const old = await readFile(path).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  if (old) {
    if (createHash("sha256").update(old).digest("hex") !== ref.sha256)
      throw Error("Corrupt suffix input cache");
    return old;
  }
  for (let attempt = 0; ; attempt++)
    try {
      const response = await fetch(url + "/download", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw Error("Suffix source HTTP " + response.status);
      const data = Buffer.from(await response.arrayBuffer());
      if (
        data.length !== ref.size ||
        createHash("sha256").update(data).digest("hex") !== ref.sha256
      )
        throw Error("Suffix source digest mismatch");
      await writeFile(path, data);
      return data;
    } catch (error) {
      if (attempt >= 8) throw error;
      await new Promise((r) =>
        setTimeout(r, Math.min(5000, 250 * 2 ** attempt)),
      );
    }
}
const df = new Uint32Array(catalogue.terms + 1);
for (const part of catalogue.partitions) {
  let id = part.firstId;
  for (const chunk of part.summaries.chunks) {
    const rows = decodeSummaries(gunzipSync(await get(chunk)));
    if (
      rows.length !== chunk.terms ||
      rows[0].word !== chunk.firstWord ||
      rows.at(-1)!.word !== chunk.lastWord
    )
      throw Error("Suffix DF partition mismatch");
    for (const row of rows) df[id++] = row.df;
  }
  if (id !== part.firstId + part.count)
    throw Error("Suffix DF coverage mismatch");
}
async function* documents() {
  let next = 0;
  for (const p of packages) {
    const run = p.numeric;
    if (
      run.first !== next ||
      run.catalogue !== packages[0].numeric.catalogue ||
      run.version !== 3
    )
      throw Error("Suffix numeric coverage mismatch");
    // Prefetch compressed numeric blocks four at a time. This is preparation,
    // outside all search timings and unrelated to simulated request caches.
    for (let at = 0; at < run.chunks.length; at += 4) {
      const chunks = run.chunks.slice(at, at + 4),
        blocks = await Promise.all(chunks.map(get));
      for (let i = 0; i < blocks.length; i++) {
        for (const row of decodeNumeric(gunzipSync(blocks[i]))) {
          if (row.doc !== next++) throw Error("Suffix numeric document gap");
          yield row;
        }
        // Source rows are durable in the constructor. Keep just the current
        // prefetch window locally while the larger suffix staging files grow.
        await rm(output + "/cache/" + chunks[i].sha256, { force: true });
      }
    }
    if (next !== run.end) throw Error("Incomplete suffix numeric run");
  }
  if (next !== root.count) throw Error("Incomplete suffix corpus");
}
const manifest = await buildSuffixIndex(
  documents(),
  {
    count: root.count,
    df,
    avgBody: root.avgBody,
    avgTitle: root.avgTitle,
    titleBoost: 2,
  },
  output,
  root.generation,
  root.analysis,
  Number(process.env.CWS_SUFFIX_SORT_MIB ?? 128),
);
await rm(output + "/cache", { recursive: true, force: true });
console.log(
  JSON.stringify({
    generation: manifest.generation,
    positions: manifest.rows,
    bytes: Object.values(manifest.files).reduce((n, f) => n + f.bytes, 0),
  }),
);
