/** Explain full-response hash differences caused by execution-plan changes. */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { LocalObjects } from "./local-storage.js";
const [beforeFile, afterFile, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "Usage: compare-research-responses.ts BEFORE.json.gz AFTER.json.gz OUTPUT.json.gz",
  );
const read = async (p: string) =>
    JSON.parse(gunzipSync(await readFile(p)).toString()),
  before = await read(beforeFile),
  after = await read(afterFile);
const reference = new Map<string, any>(
  before.rows.map((r: any) => [r.brief_id, r]),
);
const changed = after.rows.filter(
  (r: any) =>
    r.condition === "cpu-no-delays" &&
    r.resultSha256 !== reference.get(r.brief_id)?.resultSha256,
);
const dir = "work/columnar-worker-stem-1m",
  pairs = "work/columnar-complete-pairs-1m",
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  source = new LocalObjects(root, "work/columnar-local-data");
source.namedDirectory = pairs;
const hash = (result: any) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(result).filter(([k]) => k !== "diagnostics"),
        ),
      ),
    )
    .digest("hex");
const responses: Record<string, any>[] = [];
for (const base of [
  process.env.CWS_CONTROL_SOURCE ?? "work/cpu-control-0a72b2c",
  ".",
]) {
  const load = (n: string) =>
    import(pathToFileURL(resolve(base, "src/columnar/" + n + ".ts")).href);
  const [
    { ColumnarIndex },
    { Reader },
    { TermDirectory },
    { DocumentDirectory },
    { PairRouter },
  ] = await Promise.all(
    [
      "search",
      "storage",
      "term-directory",
      "document-directory",
      "pair-router",
    ].map(load),
  );
  const index = new ColumnarIndex(
    root,
    undefined,
    new TermDirectory(await readFile(dir + "/directory.bin"), root.count),
    undefined,
    new DocumentDirectory(await readFile(dir + "/documents.bin")),
    {
      router: new PairRouter(await readFile(pairs + "/router.bin")),
      N: 100,
      M: 1000,
      presence: JSON.parse(await readFile(pairs + "/presence.json", "utf8")),
    },
  );
  const results: Record<string, any> = {};
  for (const q of changed)
    results[q.brief_id] = await index.search(
      q.query,
      new Reader(root, source),
      after.manifest.options,
    );
  responses.push(results);
}
const comparisons = [];
for (const q of changed) {
  const a = responses[0][q.brief_id],
    b = responses[1][q.brief_id];
  if (
    hash(a) !== reference.get(q.brief_id).resultSha256 ||
    hash(b) !== q.resultSha256
  )
    throw Error("Could not reproduce hash difference " + q.brief_id);
  if (
    JSON.stringify(a.results.map((h: any) => [h.id, h.doc])) !==
    JSON.stringify(b.results.map((h: any) => [h.id, h.doc]))
  )
    throw Error("Ranking mismatch " + q.brief_id);
  for (const key of Object.keys(a))
    if (
      key !== "results" &&
      key !== "diagnostics" &&
      JSON.stringify(a[key]) !== JSON.stringify(b[key])
    )
      throw Error("Response field mismatch " + key);
  const differences = [];
  for (let i = 0; i < a.results.length; i++) {
    const ah = a.results[i],
      bh = b.results[i];
    const keys = Object.keys(ah).filter(
      (k) => JSON.stringify(ah[k]) !== JSON.stringify(bh[k]),
    );
    if (keys.some((k) => !["score", "snippet"].includes(k)))
      throw Error("Metadata mismatch " + q.brief_id);
    if (Math.abs(ah.score - bh.score) > 1e-11 * Math.max(1, Math.abs(ah.score)))
      throw Error("Score exceeds existing oracle tolerance " + q.brief_id);
    if (keys.length)
      differences.push({
        rank: i + 1,
        doc: ah.doc,
        fields: keys,
        before: ah,
        after: bh,
        scoreDifference: bh.score - ah.score,
      });
  }
  comparisons.push({ id: q.brief_id, q: q.query, differences });
}
if (source.downloads) throw Error("Unexpected download");
await writeFile(
  output,
  gzipSync(
    JSON.stringify(
      {
        kind: "Existing execution paths have float64 recomputation and passage-selection differences. Ranked IDs/order and metadata must match; scores checked with the existing source-oracle tolerance. This does not establish bit-identical scores across plans.",
        beforeFile,
        afterFile,
        comparisons,
      },
      null,
      2,
    ),
  ),
);
console.log(
  changed.length,
  "changed full-response hashes; ranked IDs/order and oracle score tolerance matched",
);
