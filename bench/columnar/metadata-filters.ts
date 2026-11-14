import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import {
  loadServingAssets,
  localServingSource,
} from "../../scripts/columnar-serving.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { MetadataIndex } from "../../src/columnar/metadata-filter.js";
import { Memory, Reader, Lru } from "../../src/columnar/storage.js";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";
const [
  dir,
  pairs,
  metadataDir,
  out = "bench/results/columnar/metadata-filters-1m",
] = process.argv.slice(2);
if (!metadataDir)
  throw Error("Usage: metadata-filters.ts INDEX PAIRS METADATA [OUTPUT]");
const a = await loadServingAssets(dir, { membershipDir: pairs, metadataDir }),
  root = a.root;
if (!a.metadata) throw Error("Metadata required");
const source = new LocalObjects(
    root,
    process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
  ),
  index = new ColumnarIndex(
    root,
    undefined,
    new TermDirectory(a.directory!, root.count),
    undefined,
    new DocumentDirectory(a.documents!),
    a.membership,
  ),
  meta = new MetadataIndex(a.metadata, root);
const io = new SimulatedIO(
    localServingSource(source, a),
    {
      r2Ms: 20,
      sharedMs: 2,
      r2MiBPerSecond: 100,
      sharedMiBPerSecond: 1000,
      jitterMs: 0,
      seed: 17,
    },
    1024,
  ),
  memory = new Memory();
memory.pages = new Lru(12 * 1048576);
const q = '"summary judgment" AND arbitration AND "third party beneficiary"';
const jobs = [
  { name: "unfiltered", filter: undefined, accept: (_m: any) => true },
  {
    name: "date-status",
    filter: {
      and: [
        { field: "date_filed", op: "gte", value: "1990-01-01" },
        { field: "date_filed", op: "lte", value: "2020-12-31" },
        { field: "precedential_status", op: "eq", value: "Published" },
      ],
    },
    accept: (m: any) =>
      m?.date_filed >= "1990-01-01" &&
      m?.date_filed <= "2020-12-31" &&
      m?.precedential_status === "Published",
  },
  {
    name: "no-matches",
    filter: { field: "date_filed", op: "gt", value: "2099-12-31" },
    accept: (_m: any) => false,
  },
];
async function search(
  job: (typeof jobs)[number],
  limit = 7,
  prime = false,
  after?: { doc: number; score: number },
) {
  const deferred: Promise<unknown>[] = [],
    reader = new Reader(
      root,
      io.source,
      memory,
      io.shared,
      "metadata-filter",
      (p) => deferred.push(p),
      { remaining: prime ? 100000 : 900 },
    );
  const start = performance.now(),
    cpu = process.cpuUsage();
  const result = await index.search(q, reader, {
    limit,
    exactTotal: true,
    metadata: true,
    snippets: true,
    after,
    documentFilter: job.filter ? meta.filter(job.filter, reader) : undefined,
  });
  const usage = process.cpuUsage(cpu),
    row = {
      wallMs: performance.now() - start,
      cpuMs: (usage.user + usage.system) / 1000,
      result,
    };
  await Promise.all(deferred);
  return row;
}
io.delaysEnabled = false;
const exhaustive = await search(jobs[0], 100, true);
assert(
  exhaustive.result.total! < 100,
  "Reference must contain the entire result set",
);
await mkdir(out, { recursive: true });
const rows: any[] = [];
let random = 81231;
const rand = () =>
  (random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 4294967296;
const schedule = Array.from(
  { length: Number(process.env.CWS_REPEATS ?? 3) },
  (_, repeat) =>
    jobs.flatMap((job) =>
      ["empty", "warm"].map((cache) => ({ job, cache, repeat, order: rand() })),
    ),
)
  .flat()
  .sort((a, b) => a.order - b.order);
for (const { job, cache, repeat } of schedule) {
  memory.clear();
  io.sharedBytes.clear();
  if (cache === "warm") {
    io.delaysEnabled = false;
    await search(job, 7, true);
  }
  io.delaysEnabled = true;
  const row = await search(job),
    expected = exhaustive.result.results.filter((h) => job.accept(h.metadata));
  assert.equal(row.result.total, expected.length);
  assert.deepEqual(
    row.result.results.map((h) => h.id),
    expected.slice(0, 7).map((h) => h.id),
  );
  row.result.results.forEach((h, i) =>
    assert(Math.abs(h.score - expected[i].score) < 1e-10),
  );
  rows.push({ name: job.name, cache, repeat, ...row });
  console.log(job.name, cache, row.wallMs.toFixed(1), row.result.total);
}
io.delaysEnabled = false;
for (const job of jobs) {
  const first = await search(job);
  const last = first.result.results.at(-1);
  if (last) {
    const next = await search(job, 7, true, {
        doc: last.doc,
        score: last.score,
      }),
      expected = exhaustive.result.results.filter((h) =>
        job.accept(h.metadata),
      );
    assert.deepEqual(
      next.result.results.map((h) => h.id),
      expected.slice(7, 14).map((h) => h.id),
    );
  }
}
const report = {
  checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  note: "Working-tree implementation; local simulated I/O only. Process CPU includes GC; pilot samples are not production percentiles.",
  generation: root.generation,
  metadataGeneration: a.metadata.generation,
  documents: root.count,
  model: io.model,
  referenceMatches: exhaustive.result.total,
  downloads: source.downloads,
  rows,
};
assert.equal(source.downloads, 0);
await writeFile(out + "/results.json", JSON.stringify(report, null, 2));
