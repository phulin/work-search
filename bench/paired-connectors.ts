import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search as optimized } from "../src/query/engine.js";
import { search as baseline } from "./baseline-v3/engine.js";
import { connectorQueries } from "./connector-queries.js";
const configs = JSON.parse(
  await readFile("bench/baseline-v3/results/results.json", "utf8"),
).results;
const rows = [];
for (const r of configs.filter(
  (x: any) =>
    x.documents === 1000000 &&
    (!process.argv[2] ||
      `${x.documents}-${x.budgetMiB}-${x.strategy}` === process.argv[2]),
)) {
  const name = `${r.documents}-${r.budgetMiB}-${r.strategy}`,
    root = `bench/generated/${name}`,
    index = new BinaryIndex(await readFile(root + "/bundle.bin")),
    storage = new FileStorage(root + "/objects");
  const samples: {
    q: string;
    beforeMs: number;
    afterMs: number;
    beforeCpuMs: number;
    afterCpuMs: number;
  }[] = [];
  async function run(fn: typeof optimized | typeof baseline, q: string) {
    const t = performance.now(),
      cpu = process.cpuUsage(),
      result = await fn(index, storage, q);
    const usage = process.cpuUsage(cpu);
    return {
      ms: performance.now() - t,
      cpuMs: (usage.user + usage.system) / 1000,
      result,
    };
  }
  for (const q of connectorQueries) {
    await run(baseline, q);
    await run(optimized, q);
  }
  for (let repeat = 0; repeat < 5; repeat++)
    for (const q of connectorQueries) {
      const [a, b] =
          repeat % 2
            ? [await run(optimized, q), await run(baseline, q)]
            : [await run(baseline, q), await run(optimized, q)],
        before = repeat % 2 ? b : a,
        after = repeat % 2 ? a : b;
      if (
        JSON.stringify(before.result.results) !==
          JSON.stringify(after.result.results) ||
        before.result.total !== after.result.total
      )
        throw new Error("Results/scores/counts differ: " + q);
      for (const key of [
        "indexRequests",
        "indexBytes",
        "metadataRequests",
        "metadataBytes",
        "fullyLocal",
      ] as const)
        if (before.result.diagnostics[key] !== after.result.diagnostics[key])
          throw new Error("I/O differs");
      samples.push({
        q,
        beforeMs: before.ms,
        afterMs: after.ms,
        beforeCpuMs: before.cpuMs,
        afterCpuMs: after.cpuMs,
      });
    }
  const p95 = (key: "beforeMs" | "afterMs") =>
    samples.map((s) => s[key]).sort((a, b) => a - b)[
      Math.ceil(samples.length * 0.95) - 1
    ];
  rows.push({
    name,
    beforeP95Ms: p95("beforeMs"),
    afterP95Ms: p95("afterMs"),
    samples,
  });
  console.log(
    name,
    p95("beforeMs").toFixed(1) +
      " → " +
      p95("afterMs").toFixed(1) +
      " ms paired P95",
  );
}
await writeFile(
  "bench/results/paired-connectors.json",
  JSON.stringify(
    {
      kind: "same-process alternating-order search calls on identical immutable v3 indexes; one warmup and five measured passes; exact results/scores/totals/I/O compared; not deployed latency",
      rows,
    },
    null,
    2,
  ),
);
