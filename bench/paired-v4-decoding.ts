import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex as V4Index } from "./baseline-v4-blocks/index.js";
import { search as v4Search } from "./baseline-v4-blocks/engine.js";
import { BinaryIndex } from "../src/format/index.js";
import { search } from "../src/query/engine.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { connectorQueries } from "./connector-queries.js";
const rows = [];
const plain = (await readFile("bench/generated/queries.txt", "utf8"))
  .split("\n")
  .filter(Boolean);
for (const name of ["100000-8-workload", "1000000-48-workload"].filter(
  (name) => !process.argv[2] || name === process.argv[2],
)) {
  const aRoot = "bench/generated/v4-" + name,
    bRoot = "bench/generated/" + name;
  const a = new V4Index(await readFile(aRoot + "/bundle.bin")),
    b = new BinaryIndex(await readFile(bRoot + "/bundle.bin")),
    aStore = new FileStorage(aRoot + "/objects"),
    bStore = new FileStorage(bRoot + "/objects");
  const samples = [];
  async function timed(fn: () => Promise<any>) {
    const t = performance.now(),
      cpu = process.cpuUsage(),
      result = await fn(),
      used = process.cpuUsage(cpu);
    return {
      ms: performance.now() - t,
      cpuMs: (used.user + used.system) / 1000,
      result,
    };
  }
  for (const [kind, queries] of [
    ["plain", plain],
    ["connectors", connectorQueries],
    [
      "selective",
      [
        "word19999 document",
        "word19999 /s engine",
        '"word19999 document"',
        "word12345 AND search",
        "word12345 /p document",
      ],
    ],
  ] as const) {
    for (const q of queries) {
      await v4Search(a, aStore, q);
      await search(b, bStore, q, { exactTotal: true });
    }
    for (let repeat = 0; repeat < 3; repeat++)
      for (const q of queries) {
        const old = () => v4Search(a, aStore, q),
          current = () => search(b, bStore, q, { exactTotal: true }),
          [x, y] =
            repeat % 2
              ? [await timed(current), await timed(old)]
              : [await timed(old), await timed(current)],
          before = repeat % 2 ? y : x,
          after = repeat % 2 ? x : y;
        if (
          JSON.stringify(before.result.results) !==
            JSON.stringify(after.result.results) ||
          before.result.total !== after.result.total
        )
          throw new Error("Results/scores/totals differ: " + q);
        if (
          kind === "plain" &&
          (after.result.diagnostics.positionRequests ||
            after.result.diagnostics.positionBytes)
        )
          throw new Error("Plain query read positions");
        samples.push({
          kind,
          q,
          beforeMs: before.ms,
          afterMs: after.ms,
          beforeCpuMs: before.cpuMs,
          afterCpuMs: after.cpuMs,
          beforeRequests: before.result.diagnostics.indexRequests,
          afterRequests: after.result.diagnostics.indexRequests,
          beforeBytes: before.result.diagnostics.indexBytes,
          afterBytes: after.result.diagnostics.indexBytes,
          positionRequests: after.result.diagnostics.positionRequests,
        });
      }
  }
  rows.push({ name, samples });
  console.log(name + " cross-format results, scores and counts match");
}
await writeFile(
  "bench/results/paired-v4-decoding.json",
  JSON.stringify(
    {
      kind: "same-process v4/v5 comparison, same ordered documents, one warmup and three alternating-order measured passes; no production latency claim",
      rows,
    },
    null,
    2,
  ),
);
