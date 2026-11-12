import { readFile, writeFile } from "node:fs/promises";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader } from "../src/global/storage.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { crc32, encoder } from "../src/format/codec.js";
import { EmpiricalModel, sleep } from "./demo-model.js";
import { demoWorkload } from "./demo-workload.js";
import { globalQueries } from "./global-workload.js";
import { BinaryIndex } from "../src/format/index.js";
import { search } from "../src/query/engine.js";
const index = new GlobalIndex(
    await readFile("work/global-100k/bundle-heads-8.bin"),
  ),
  disk = new FileStorage("work/global-100k/packs"),
  samples = JSON.parse(
    await readFile("work/demo-bench/latency.json", "utf8"),
  ).rows,
  reference = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  ),
  oldDisk = new FileStorage("bench/generated/flp-100000/source/objects"),
  rows: any[] = [],
  oracle: Record<string, any> = {};
const queries = [
  ...demoWorkload,
  ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
];
for (const q of queries)
  oracle[q.q] = (
    await search(reference, oldDisk, q.q, {
      metadata: true,
      internalDoc: true,
      executor: "materialized",
    })
  ).results;
await writeFile(
  "work/global-bench/competitive-oracle.json",
  JSON.stringify(oracle),
);
for (const [qi, q] of queries.entries()) {
  if (
    process.env.GLOBAL_QUERY_FILTER &&
    !q.q.includes(process.env.GLOBAL_QUERY_FILTER)
  )
    continue;
  for (const competitivePositions of qi % 2 ? [true, false] : [false, true]) {
    const source = {
      async open(key: string, offset: number, length: number) {
        const seed =
          crc32(encoder.encode(key + ":" + offset + ":" + length)) + qi;
        const latency = new EmpiricalModel(
          samples,
          seed,
          "empirical",
          "varied-range",
        ).sample(length);
        if (process.env.GLOBAL_NO_LATENCY !== "1")
          await sleep(latency.headersMs);
        return {
          bytes: (async () => {
            if (process.env.GLOBAL_NO_LATENCY !== "1")
              await sleep(latency.bodyMs);
            return disk.read(key.split("/").at(-1)!, offset, length);
          })(),
        };
      },
      async read(key: string, offset: number, length: number) {
        return (await this.open(key, offset, length)).bytes;
      },
    };
    const reader = new PageReader(
        { ...index.root, pageBytes: 262144, objectPages: 256 },
        source,
        new SearchRuntime(8 * 1048576),
      ),
      start = performance.now(),
      cpu = process.cpuUsage(),
      result = await index.search(reader, q.q, {
        competitivePositions,
        decodedReads: process.env.GLOBAL_DECODED_READS !== "0",
      }),
      used = process.cpuUsage(cpu),
      want = oracle[q.q];
    if (
      result.results.length !== want.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== want[i].id ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(h.score)),
      )
    )
      throw Error("Competitive ranking " + q.q);
    rows.push({
      configuredCompetitive: competitivePositions,
      ...q,
      group: qi < demoWorkload.length ? "legal" : "stress",
      ms: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      ...result.diagnostics,
    });
    console.log(
      competitivePositions,
      q.q,
      Math.round(performance.now() - start),
      result.diagnostics.requests,
      result.diagnostics.verifiedDocuments,
    );
    await writeFile(
      "work/global-bench/" +
        (process.env.GLOBAL_COMPETITIVE_LABEL ?? "competitive") +
        (process.env.GLOBAL_NO_LATENCY === "1" ? "-cpu" : "") +
        ".json",
      JSON.stringify({
        kind: "Paired fixed per-page empirical R2 latency, 8MiB complete-heads, 256KiB pages, cold memory and no shared cache; no latency mode measures local CPU only",
        rows,
      }),
    );
  }
}
