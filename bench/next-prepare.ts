// Run npm run bench first to generate the original v5 fixtures, or retain those
// fixtures from the previous release. The reader supports both v5 and v8 inputs.
import { repack } from "./repack.js";
import { readFile } from "node:fs/promises";
const queries = (await readFile("bench/generated/queries.txt", "utf8"))
  .split("\n")
  .filter(Boolean);
for (const stage of [4, 5, 7]) {
  const label = stage === 4 ? "4" : `${stage}r`;
  const source =
    stage === 4
      ? "bench/generated/1000000-8-workload"
      : `bench/generated/next-${stage === 5 ? "4" : "5r"}-8`;
  await repack(
    source,
    `bench/generated/next-${label}-8`,
    8388608,
    "frequency",
    queries,
    stage,
  );
  for (const budget of [16, 32, 48])
    await repack(
      `bench/generated/next-${label}-8`,
      `bench/generated/next-${label}-${budget}`,
      budget * 1048576,
      "frequency",
      queries,
    );
}
