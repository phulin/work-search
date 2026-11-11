import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { DocumentTable as Baseline } from "./baseline-v2/documents.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { handler } from "../src/worker/handler.js";
const { results } = JSON.parse(
  await readFile("bench/baseline-v2/results/results.json", "utf8"),
);
const queries = (await readFile("bench/generated/queries.txt", "utf8"))
  .split("\n")
  .filter(Boolean);
const rows = [];
for (const r of results.filter(
  (r: any) =>
    r.documents === 1000000 &&
    r.status === "ok" &&
    (!process.argv[2] ||
      `${r.documents}-${r.budgetMiB}-${r.strategy}` === process.argv[2]),
)) {
  const name = `${r.documents}-${r.budgetMiB}-${r.strategy}`,
    root = `bench/generated/${name}`,
    bytes = await readFile(root + "/bundle.bin");
  const optimized = new BinaryIndex(bytes),
    baseline = new BinaryIndex(bytes);
  Object.defineProperty(baseline, "documents", {
    value: new Baseline(
      bytes.subarray(baseline.docs, baseline.local),
      baseline.count,
    ),
  });
  const store = new FileStorage(root + "/objects"),
    old = handler(baseline, store, true),
    current = handler(optimized, store, true);
  const samples: {
    q: string;
    baselineMs: number;
    optimizedMs: number;
    baselineCpuMs: number;
    optimizedCpuMs: number;
  }[] = [];
  async function run(h: ReturnType<typeof handler>, q: string) {
    const t = performance.now(),
      cpu = process.cpuUsage();
    const response = await h(
      new Request(
        "https://local/search?total=true&diagnostics=true&q=" +
          encodeURIComponent(q),
      ),
    );
    const body = (await response.json()) as any;
    if (response.status !== 200) throw new Error("Query failed");
    const usage = process.cpuUsage(cpu);
    return {
      ms: performance.now() - t,
      cpuMs: (usage.user + usage.system) / 1000,
      body,
    };
  }
  for (const q of queries) {
    await run(old, q);
    await run(current, q);
  }
  for (let pass = 0; pass < 10; pass++)
    for (const q of queries) {
      const [a, b] =
        pass % 2
          ? [await run(current, q), await run(old, q)]
          : [await run(old, q), await run(current, q)];
      const before = pass % 2 ? b : a,
        after = pass % 2 ? a : b;
      if (
        JSON.stringify(before.body.results) !==
          JSON.stringify(after.body.results) ||
        before.body.total !== after.body.total
      )
        throw new Error("Search results differ");
      for (const key of [
        "indexRequests",
        "indexBytes",
        "metadataRequests",
        "metadataBytes",
        "fullyLocal",
      ])
        if (before.body.diagnostics[key] !== after.body.diagnostics[key])
          throw new Error("I/O differs");
      samples.push({
        q,
        baselineMs: before.ms,
        optimizedMs: after.ms,
        baselineCpuMs: before.cpuMs,
        optimizedCpuMs: after.cpuMs,
      });
    }
  const percentile = (key: "baselineMs" | "optimizedMs", p: number) =>
    samples.map((s) => s[key]).sort((a, b) => a - b)[
      Math.ceil(samples.length * p) - 1
    ];
  rows.push({
    name,
    baselineP50Ms: percentile("baselineMs", 0.5),
    optimizedP50Ms: percentile("optimizedMs", 0.5),
    baselineP95Ms: percentile("baselineMs", 0.95),
    optimizedP95Ms: percentile("optimizedMs", 0.95),
    baselineCpuMs:
      samples.reduce((s, x) => s + x.baselineCpuMs, 0) / samples.length,
    optimizedCpuMs:
      samples.reduce((s, x) => s + x.optimizedCpuMs, 0) / samples.length,
    samples,
  });
  console.log(
    name,
    rows.at(-1)!.baselineP95Ms.toFixed(2) +
      " → " +
      rows.at(-1)!.optimizedP95Ms.toFixed(2) +
      "ms paired P95",
  );
}
await writeFile(
  "bench/results/paired.json",
  JSON.stringify(
    {
      kind: "same process, alternating order, same immutable v2 bytes, frozen 6799e3d document reader vs optimized; one unmeasured warmup per query then ten measured repetitions; filesystem HTTP handler; results, exact totals and I/O verified equal",
      rows,
    },
    null,
    2,
  ),
);
