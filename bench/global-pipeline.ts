import { readFile, writeFile } from "node:fs/promises";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader } from "../src/global/storage.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { crc32, encoder } from "../src/format/codec.js";
import { EmpiricalModel, sleep } from "./demo-model.js";
import { demoWorkload } from "./demo-workload.js";
const index = new GlobalIndex(await readFile("work/global-100k/bundle-8.bin")),
  disk = new FileStorage("work/global-100k/packs"),
  samples = JSON.parse(
    await readFile("work/demo-bench/latency.json", "utf8"),
  ).rows,
  oracle = JSON.parse(await readFile("work/global-bench/oracle.json", "utf8")),
  rows: any[] = [];
for (const pipeline of [false, true])
  for (const [qi, q] of demoWorkload.entries()) {
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
        await sleep(latency.headersMs);
        return {
          bytes: (async () => {
            await sleep(latency.bodyMs);
            return disk.read(key.split("/").at(-1)!, offset, length);
          })(),
        };
      },
      async read(key: string, o: number, n: number) {
        return (await this.open(key, o, n)).bytes;
      },
    };
    const reader = new PageReader(
        { ...index.root, pageBytes: 131072, objectPages: 512 },
        source,
        new SearchRuntime(8 * 1048576),
        undefined,
        undefined,
        pipeline,
      ),
      start = performance.now(),
      cpu = process.cpuUsage(),
      r = await index.search(reader, q.q),
      used = process.cpuUsage(cpu),
      want = oracle[q.q];
    if (
      r.results.length !== want.length ||
      r.results.some(
        (h: any, i: number) =>
          h.id !== want[i].id ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(h.score)),
      )
    )
      throw Error("Pipeline ranking " + q.q);
    rows.push({
      pipeline,
      ...q,
      ms: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      ...r.diagnostics,
    });
    console.log(pipeline, q.q, r.diagnostics.milliseconds);
    await writeFile(
      "work/global-bench/pipeline.json",
      JSON.stringify({
        kind: "Local empirical varied-range header/body latency; per-page fixed seed for paired comparisons; 8 MiB bundle, 128 KiB reads; no shared cache; fresh memory per query",
        rows,
      }),
    );
  }
