import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { search } from "../src/query/engine.js";
const root = "bench/generated/flp-100000",
  results = "bench/results";
const designs = ["32-mixed", "48-mixed", "paged"];
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
    for (const latency of [0, 5, 20])
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
    bytes = await readFile(`${root}/${design}/bundle.bin`),
    index = openIndex(bytes),
    startupMs = performance.now() - start;
  const storage = new FileStorage(`${root}/${design}/objects`),
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
          peakActive = 0;
        const delayed = {
          read: async (key: string, offset: number, length: number) => {
            requests++;
            transferred += length;
            peakActive = Math.max(peakActive, ++active);
            try {
              if (latency) await new Promise((r) => setTimeout(r, latency));
              return await storage.read(key, offset, length);
            } finally {
              active--;
            }
          },
        };
        const cpu = process.cpuUsage(),
          start = performance.now();
        const got = await search(index, delayed, q, { runtime });
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
        });
      }
  }
  const record = {
    design,
    latencyMs: latency,
    latencyModel:
      "Fixed added delay per actual storage request, overlapping concurrent requests; no bandwidth cap/jitter. Local simulation, not Cloudflare measurements.",
    startupMs,
    bundleBytes: bytes.length,
    maxProcessRss: maxRss,
    node: process.version,
    rows,
  };
  await writeFile(
    `${results}/paged-${design}-${latency}.json`,
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(`${design} +${latency}ms: ${rows.length} exact checks passed`);
}
