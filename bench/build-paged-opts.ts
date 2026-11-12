import { pageIndex } from "../src/builder/page-index.js";
import { readFile } from "node:fs/promises";
const queries = JSON.parse(
  await readFile("bench/results/flp100k-queries.json", "utf8"),
).train.map((x: any) => x.q);
const step = Number(process.argv[2]),
  budget = Number(process.argv[3] ?? 8);
console.log(
  await pageIndex(
    "bench/generated/flp-100000/48-mixed",
    `bench/generated/flp-100000/opt${step}-${budget}`,
    {
      optimizationStep: step,
      localTables: true,
      hotDescriptors: 10000,
      embedPostings: step >= 2,
      inlineTiny: step >= 4,
      workload: queries,
      budget: budget * 1048576,
    },
  ),
);
