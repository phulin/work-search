import { readFile, writeFile, mkdir } from "node:fs/promises";
import { GlobalIndex, type GlobalSearchOptions } from "../src/global/search.js";
import { PageReader } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { demoWorkload } from "./demo-workload.js";
import { Slots, sleep } from "./demo-model.js";
const index = new GlobalIndex(await readFile("work/global-100k/bundle-8.bin")),
  disk = new FileStorage("work/global-100k/packs"),
  oracle = JSON.parse(await readFile("work/global-bench/oracle.json", "utf8"));
const rounds: { name: string; options: GlobalSearchOptions }[] = [
  {
    name: "0-coarse-four",
    options: {
      microPlans: false,
      batchTiles: 4,
      decodedCache: false,
      directPositions: false,
    },
  },
  {
    name: "1-tight-bulk",
    options: {
      microPlans: true,
      batchTiles: 32,
      decodedCache: false,
      directPositions: false,
    },
  },
  {
    name: "2-direct-decode",
    options: {
      microPlans: true,
      batchTiles: 32,
      decodedCache: true,
      directPositions: true,
    },
  },
  {
    name: "3-result-prefetch",
    options: {
      microPlans: true,
      batchTiles: 32,
      decodedCache: true,
      directPositions: true,
      prefetch: true,
    },
  },
];
rounds.push({
  name: "4-complete-heads",
  options: {
    microPlans: true,
    batchTiles: 32,
    decodedCache: true,
    directPositions: true,
  },
});
const rows: any[] = [];
rounds.forEach((r) => {
  r.options.heapAdmission = false;
  r.options.decodedReads = false;
});
rounds.push({
  name: "5-heap-admission",
  options: { ...rounds.at(-1)!.options, heapAdmission: true },
});
rounds.push({
  name: "6-decoded-read-reuse",
  options: { ...rounds.at(-1)!.options, decodedReads: true },
});
for (const round of rounds)
  for (const q of demoWorkload) {
    const selectedIndex =
      round.name.startsWith("4-") ||
      round.name.startsWith("5-") ||
      round.name.startsWith("6-")
        ? new GlobalIndex(await readFile("work/global-100k/bundle-heads-8.bin"))
        : index;
    const slots = new Slots(6),
      source = {
        read: async (key: string, o: number, n: number) => {
          const release = await slots.acquire();
          try {
            await sleep(20);
            return await disk.read(key.split("/").at(-1)!, o, n);
          } finally {
            release();
          }
        },
      },
      reader = new PageReader(
        index.root,
        source,
        new SearchRuntime(8 * 1048576),
      ),
      start = performance.now(),
      cpu = process.cpuUsage();
    const result = await selectedIndex.search(reader, q.q, round.options),
      ms = performance.now() - start,
      used = process.cpuUsage(cpu),
      expected = oracle[q.q];
    if (
      result.results.length !== expected.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== expected[i].id ||
          Math.abs(h.score - expected[i].score) >
            1e-11 * Math.max(1, Math.abs(expected[i].score)),
      )
    )
      throw Error("Round ranking mismatch " + round.name + " " + q.q);
    rows.push({
      round: round.name,
      ...q,
      ms,
      cpuMs: (used.user + used.system) / 1000,
      rss: process.memoryUsage().rss,
      ...result.diagnostics,
    });
    await writeFile(
      "work/global-bench/rounds.json",
      JSON.stringify({
        kind: "Same final binary index, 8-MiB bundle, 64-KiB reads, empty per-query memory cache, fixed 20ms per R2 read with six full-read slots; local simulation not native",
        rows,
      }),
    );
    console.log(
      round.name,
      q.q,
      Math.round(ms),
      result.diagnostics.storageRounds,
      result.diagnostics.requests,
    );
  }
