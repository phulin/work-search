import { readFile, writeFile } from "node:fs/promises";
const rows = [];
for (const label of ["before", "after"]) {
  const p = JSON.parse(
      await readFile(
        `bench/generated/profiles/connectors-${label}.cpuprofile`,
        "utf8",
      ),
    ),
    counts = new Map<number, number>();
  for (const id of p.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
  const functions = p.nodes
    .filter(
      (n: any) =>
        /evaluate\.ts$|codec\.ts$/.test(n.callFrame.url) ||
        n.callFrame.functionName === "(garbage collector)",
    )
    .map((n: any) => ({
      function: n.callFrame.functionName,
      file: n.callFrame.url.split("/").slice(-2).join("/"),
      selfSamples: counts.get(n.id) ?? 0,
    }))
    .filter((x: any) => x.selfSamples)
    .sort((a: any, b: any) => b.selfSamples - a.selfSamples);
  rows.push({ label, totalSamples: p.samples.length, functions });
}
await writeFile(
  "bench/results/positional-profile.json",
  JSON.stringify(
    {
      kind: "V8 sampled profiles, identical 48 MiB workload index, four passes over three common positional queries; self attribution includes JIT effects and is not a precise function timer",
      rows,
    },
    null,
    2,
  ),
);
