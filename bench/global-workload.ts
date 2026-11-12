import { readFile } from "node:fs/promises";
const workload = JSON.parse(
  await readFile("bench/results/flp100k-queries.json", "utf8"),
);
const evaluation = workload.eval ?? workload.test ?? workload.queries;
if (!Array.isArray(evaluation)) throw Error("Missing evaluation workload");
export const globalQueries = [
  ...new Set<string>(evaluation.map((q: any) => q.kind)),
].flatMap((kind) => evaluation.filter((q: any) => q.kind === kind).slice(0, 4));
export const globalWarmup = workload.train.slice(0, 16);
export const globalRepeat = globalQueries.slice(0, 8);
