import { build } from "../src/builder/build.js";
import { readFile, writeFile } from "node:fs/promises";
import { repack } from "./repack.js";
const root = "bench/generated/flp",
  workload = (await readFile(root + "/training.txt", "utf8"))
    .split("\n")
    .filter(Boolean);
const reuse = process.argv.includes("--reuse-source");
const record: any[] = reuse
  ? JSON.parse(await readFile("bench/results/flp-builds.json", "utf8")).filter(
      (r: any) => r.kind === "full corpus ingestion",
    )
  : [];
if (!reuse) {
  const started = performance.now();
  const source = await build({
    input: root + "/corpus.jsonl",
    out: root + "/source",
    budget: 48 * 1048576,
    strategy: "smallest",
    chunkDocs: 100,
  });
  record.push({
    kind: "full corpus ingestion",
    ms: performance.now() - started,
    manifest: source,
  });
  await writeFile(
    "bench/results/flp-builds.json",
    JSON.stringify(record, null, 2),
  );
}
record.push({
  kind: "legacy varint stream conversion for storage comparison",
  ...(await repack(
    root + "/source",
    root + "/legacy",
    48 * 1048576,
    "frequency",
    workload,
    4,
  )),
});
await writeFile(
  "bench/results/flp-builds.json",
  JSON.stringify(record, null, 2),
);
for (const budget of [8, 16, 32, 48])
  for (const policy of ["frequency", "mixed"] as const) {
    try {
      record.push({
        budgetMiB: budget,
        ...(await repack(
          root + "/source",
          `${root}/${budget}-${policy}`,
          budget * 1048576,
          policy,
          workload,
        )),
      });
    } catch (error) {
      record.push({ budgetMiB: budget, policy, error: String(error) });
    }
    await writeFile(
      "bench/results/flp-builds.json",
      JSON.stringify(record, null, 2),
    );
  }
