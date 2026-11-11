import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { search as reference } from "../bench/baseline-next.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { connectorQueries } from "./connector-queries.js";
const stage = process.argv[2] ?? "0";
const n = Number(process.argv[3] ?? 1000000),
  policy = process.argv[4] ?? "frequency",
  matrix = process.argv[5] === "matrix";
const plain = (await readFile("bench/generated/queries.txt", "utf8"))
  .split("\n")
  .filter(Boolean);
const samples: any[] = [];
for (const budget of [8, 16, 32, 48]) {
  const root = matrix
    ? `bench/generated/matrix-${n}-${budget}-${policy}`
    : Number(stage) >= 4
      ? `bench/generated/${n === 1000000 ? "next" : `next-${n}`}-${stage === "6" || stage === "5" ? "5r" : stage === "7" ? "7r" : stage}-${budget}${policy === "mixed" ? "-mixed" : ""}`
      : `bench/generated/${n}-${budget}-workload`;
  const oracleRoot = `bench/generated/${n}-${budget}-workload`;
  const oracle = new BinaryIndex(await readFile(oracleRoot + "/bundle.bin")),
    oracleStorage = new FileStorage(oracleRoot + "/objects");
  const index = new BinaryIndex(await readFile(root + "/bundle.bin")),
    storage = new FileStorage(root + "/objects");
  for (const [kind, queries] of [
    ["plain", plain],
    ["connector", connectorQueries],
  ] as const) {
    for (const q of queries) {
      const expected = await reference(oracle, oracleStorage, q, {
        exactTotal: true,
      });
      const runtime = new SearchRuntime();
      for (let pass = 0; pass < 4; pass++) {
        const start = performance.now(),
          cpu = process.cpuUsage();
        let r;
        try {
          r = await search(index, storage, q, {
            runtime,
            blockCache: Number(stage) >= 6,
            optimizationStage: Number(stage),
          });
        } catch (e) {
          throw new Error(`${stage}/${budget}/${q}`, { cause: e });
        }
        const elapsedMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        if (JSON.stringify(r.results) !== JSON.stringify(expected.results))
          throw Error(`Mismatch ${stage} ${budget} ${q}`);
        samples.push({
          budget,
          kind,
          q,
          pass,
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          ms: elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          ...r.diagnostics,
        });
      }
    }
  }
}
const pct = (xs: number[], p: number) =>
  xs.sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
const summary = [];
for (const budget of [8, 16, 32, 48])
  for (const kind of ["plain", "connector"])
    for (const cold of [true, false]) {
      const rows = samples.filter(
        (s) =>
          s.budget === budget &&
          s.kind === kind &&
          (cold ? s.pass === 0 : s.pass > 0),
      );
      summary.push({
        budget,
        kind,
        cold,
        p50: pct(
          rows.map((s) => s.ms),
          0.5,
        ),
        p95: pct(
          rows.map((s) => s.ms),
          0.95,
        ),
        cpu: rows.reduce((s, r) => s + r.cpuMs, 0) / rows.length,
        reads: rows.reduce((s, r) => s + r.indexRequests, 0) / rows.length,
        bytes: rows.reduce((s, r) => s + r.indexBytes, 0) / rows.length,
      });
    }
await writeFile(
  `bench/results/next-${stage}${n === 1000000 ? "" : `-${n}`}${policy === "mixed" ? "-mixed" : ""}${matrix ? "-matrix" : ""}.json`,
  JSON.stringify(
    {
      stage,
      n,
      policy,
      local: true,
      peakProcessRss: process.resourceUsage().maxRSS * 1024,
      samples,
      summary,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary));
