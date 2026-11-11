import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { handler } from "../src/worker/handler.js";
import { createHash } from "node:crypto";
import { connectorQueries } from "./connector-queries.js";
const [input, out, budget, strategy, queryFile, resultFile] =
  process.argv.slice(2);
const queries = (await readFile(queryFile, "utf8")).split("\n").filter(Boolean);
try {
  const cpuStart = process.cpuUsage();
  const reuse = process.argv.includes("--reuse-indexes");
  const m = reuse
    ? JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
    : await build({
        input,
        out,
        budget: Number(budget) * 1024 * 1024,
        strategy: strategy as "smallest" | "workload",
        workload: queries,
      });
  if (reuse) {
    const old = JSON.parse(await readFile(resultFile, "utf8"));
    if (old.format !== m.format || old.bundleSha256 !== m.bundleSha256)
      throw new Error(
        "Reuse requires a prior construction record for this exact format/index",
      );
    m.buildMs = old.buildMs;
    m.peakRssBytes = old.peakRssBytes;
    if (m.budget !== Number(budget) * 1024 * 1024 || m.strategy !== strategy)
      throw new Error("Index configuration mismatch");
    for (const o of m.objects) {
      const bytes = await readFile(join(out, "objects", o.key));
      if (
        bytes.length !== o.size ||
        createHash("sha256").update(bytes).digest("hex") !== o.sha256
      )
        throw new Error("Object checksum mismatch");
    }
  }
  const load = performance.now(),
    bytes = await readFile(join(out, "bundle.bin")),
    index = new BinaryIndex(bytes),
    loadMs = performance.now() - load;
  if (createHash("sha256").update(bytes).digest("hex") !== m.bundleSha256)
    throw new Error("Bundle checksum mismatch");
  const construct = performance.now();
  for (let i = 0; i < 100; i++) new BinaryIndex(bytes);
  const constructorMs = (performance.now() - construct) / 100;
  const store = new FileStorage(join(out, "objects")),
    h = handler(index, store, true);
  async function measure(queryList: string[]) {
    const samples: any[] = [];
    for (let repeat = 0; repeat < 3; repeat++)
      for (const q of queryList) {
        const start = performance.now(),
          cpu = process.cpuUsage();
        try {
          const response = await h(
            new Request(
              "https://local/search?diagnostics=true&q=" +
                encodeURIComponent(q),
            ),
          );
          const result = (await response.json()) as any;
          if (response.status !== 200) throw new Error(result.error);
          const usage = process.cpuUsage(cpu);
          samples.push({
            q,
            ms: performance.now() - start,
            cpuMs: (usage.user + usage.system) / 1000,
            ...result.diagnostics,
            total: result.total,
          });
        } catch (e) {
          samples.push({ q, error: String(e) });
        }
      }
    return samples;
  }
  const samples = await measure(queries),
    connectorSamples = await measure(connectorQueries);
  const good = samples.filter((x) => !x.error),
    sorted = good.map((x) => x.ms).sort((a, b) => a - b),
    mean = (key: string) => good.reduce((s, x) => s + x[key], 0) / good.length;
  const cpu = process.cpuUsage(cpuStart);
  await writeFile(
    resultFile,
    JSON.stringify(
      {
        status: "ok",
        buildMeasurement: reuse
          ? "Inherited matching construction timing/RSS; query metrics remeasured"
          : "Fresh build",
        ...m,
        loadMs,
        constructorMs,
        throughput: m.documents / (m.buildMs / 1000),
        storageBytes:
          m.bundleBytes +
          m.objects.reduce((s: number, o: { size: number }) => s + o.size, 0),
        zeroReadPercent:
          (100 * good.filter((x) => x.fullyLocal).length) / good.length,
        avgRequests: mean("indexRequests"),
        avgBytes: mean("indexBytes"),
        p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        avgCpuMs: mean("cpuMs"),
        queryPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        totalCpuMs: (cpu.user + cpu.system) / 1000,
        samples,
        connectorSamples,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await writeFile(
    resultFile,
    JSON.stringify({
      status: "infeasible",
      error: String(e),
      budgetMiB: Number(budget),
      strategy,
    }),
  );
}
