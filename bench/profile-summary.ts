import { readFile, writeFile } from "node:fs/promises";
const profiles = [];
for (const name of ["before", "after"]) {
  const p = JSON.parse(
    await readFile(`bench/generated/profiles/${name}.cpuprofile`, "utf8"),
  );
  const counts = new Map<number, number>();
  for (const id of p.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const documentFunctions = p.nodes
    .filter((n: any) => /documents\.ts$/.test(n.callFrame.url))
    .map((n: any) => ({
      function: n.callFrame.functionName,
      samples: counts.get(n.id) ?? 0,
    }))
    .filter((x: any) => x.samples);
  profiles.push({
    name,
    totalSamples: p.samples.length,
    documentFunctions,
    documentSelfSamples: documentFunctions.reduce(
      (s: number, x: any) => s + x.samples,
      0,
    ),
  });
}
await writeFile(
  "bench/results/cpu-profile-summary.json",
  JSON.stringify(
    {
      kind: "V8 CPU self-samples, same 48 MiB workload index and query sequence; approximate attribution including JIT effects",
      profiles,
    },
    null,
    2,
  ),
);
