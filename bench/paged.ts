import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { search } from "../src/query/engine.js";
const root = "bench/generated/flp-100000",
  results = "bench/results";
const designs = (process.env.PAGED_DESIGNS ?? "32-mixed,48-mixed,paged").split(
  ",",
);
const prefix = process.env.PAGED_PREFIX ?? "paged";
const delays = (process.env.PAGED_DELAYS ?? "0,5,20").split(",").map(Number);
const bandwidth = Number(process.env.PAGED_BANDWIDTH_MIB ?? 0);
if (!process.argv.includes("--task")) {
  const index = openIndex(await readFile(`${root}/48-mixed/bundle.bin`)),
    storage = new FileStorage(`${root}/48-mixed/objects`);
  const workload = JSON.parse(
      await readFile("bench/results/flp100k-queries.json", "utf8"),
    ).test,
    expected = [];
  for (const { q } of workload)
    expected.push([
      q,
      (await search(index, storage, q, { exactTotal: true })).results,
    ]);
  await writeFile("work/paged-expected.json", JSON.stringify(expected));
  for (const design of designs)
    for (const latency of delays)
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            import.meta.filename,
            "--task",
            design,
            String(latency),
          ],
          { stdio: "inherit" },
        );
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(Error(`Benchmark exited ${code}`)),
        );
      });
} else {
  const design = process.argv[process.argv.indexOf("--task") + 1],
    latency = Number(process.argv.at(-1));
  const start = performance.now(),
    bytes = await readFile(
      `${root}/${design === "hybrid-adaptive" ? "hybrid-tables" : design}/bundle.bin`,
    ),
    index = openIndex(bytes),
    startupMs = performance.now() - start;
  const storage = new FileStorage(
      `${root}/${design === "hybrid-adaptive" ? "hybrid-tables" : design}/objects`,
    ),
    runtime = new SearchRuntime(4 * 1048576);
  const workload = JSON.parse(
    await readFile("bench/results/flp100k-queries.json", "utf8"),
  ).test;
  const expected = new Map<string, unknown>(
    JSON.parse(await readFile("work/paged-expected.json", "utf8")),
  );
  const rows = [];
  let maxRss = process.memoryUsage().rss;
  for (const phase of ["cold", "mixed"]) {
    runtime.clear();
    for (let pass = 0; pass < (phase === "cold" ? 1 : 2); pass++)
      for (const { q, kind } of workload) {
        if (phase === "cold") runtime.clear();
        let requests = 0,
          transferred = 0,
          active = 0,
          transferEnd = 0;
        const io: Record<string, { requests: number; bytes: number }> = {};
        let peakActive = 0;
        const delayed = {
          read: async (key: string, offset: number, length: number) => {
            requests++;
            const kind = key
              .slice(key.lastIndexOf("/") + 1)
              .replace(/-\d+\.bin$/, "");
            const counters = (io[kind] ??= { requests: 0, bytes: 0 });
            counters.requests++;
            counters.bytes += length;
            transferred += length;
            peakActive = Math.max(peakActive, ++active);
            try {
              if (latency) await new Promise((r) => setTimeout(r, latency));
              if (bandwidth) {
                transferEnd =
                  Math.max(performance.now(), transferEnd) +
                  length / ((bandwidth * 1048576) / 1000);
                await new Promise((r) =>
                  setTimeout(r, Math.max(0, transferEnd - performance.now())),
                );
              }
              return await storage.read(key, offset, length);
            } finally {
              active--;
            }
          },
        };
        const cpu = process.cpuUsage(),
          start = performance.now();
        const got = await search(index, delayed, q, {
          competitivePositions:
            process.env.PAGED_COMPETITIVE !== "false" &&
            design.startsWith("opt") &&
            Number(design.slice(3).split("-")[0]) >= 3,
          r2LatencyMs: latency,
          r2BandwidthMiB: bandwidth || 50,
          pagedOptimizationStep: design.startsWith("opt")
            ? Number(design.slice(3).split("-")[0])
            : 0,
          runtime,
          pagedReadPolicy:
            design === "hybrid-adaptive" || design.startsWith("opt")
              ? "adaptive"
              : "fixed",
        });
        const ms = performance.now() - start,
          used = process.cpuUsage(cpu);
        if (JSON.stringify(got.results) !== JSON.stringify(expected.get(q)))
          throw Error(`Mismatch: ${design}: ${q}`);
        if (
          requests !==
          got.diagnostics.indexRequests + got.diagnostics.metadataRequests
        )
          throw Error("Unaccounted reads");
        const rss = process.memoryUsage().rss;
        maxRss = Math.max(maxRss, rss);
        rows.push({
          q,
          kind,
          phase,
          pass,
          ms,
          cpuMs: (used.user + used.system) / 1000,
          requests,
          bytes: transferred,
          peakActive,
          diagnostics: got.diagnostics,
          io,
        });
      }
  }
  const record = {
    design,
    latencyMs: latency,
    bandwidthMiBps: bandwidth,
    latencyModel: `Fixed delay per request, overlapping concurrency; ${bandwidth ? bandwidth + " MiB/s shared FIFO transfer budget" : "no bandwidth cap"}; no jitter. Local simulation, not Cloudflare measurements.`,
    startupMs,
    bundleBytes: bytes.length,
    maxProcessRss: maxRss,
    node: process.version,
    rows,
  };
  await writeFile(
    `${results}/${prefix}-${design}-${latency}${bandwidth ? "-bw" + bandwidth : ""}.json`,
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(`${design} +${latency}ms: ${rows.length} exact checks passed`);
}
