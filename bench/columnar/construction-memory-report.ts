import { readFile, writeFile } from "node:fs/promises";
const [input, out] = process.argv.slice(2);
if (!out) throw Error("Use MEMORY_RESULTS_JSON OUTPUT_JSON");
const source = JSON.parse(await readFile(input, "utf8"));
const observations = source.memory.filter((r: any) =>
  Number.isFinite(r.usedSize),
);
const phases = source.profiles.map((p: any) => {
  const samples = observations.filter((r: any) => r.label === p.phase);
  const retained = observations.find(
    (r: any) => r.label === "retained-" + p.phase,
  );
  return {
    phase: p.phase,
    heapSamples: samples.length,
    maxObservedHeapMiB:
      Math.max(0, ...samples.map((r: any) => r.usedSize)) / 1048576,
    maxObservedBackingStorageMiB:
      Math.max(0, ...samples.map((r: any) => r.backingStorageSize ?? 0)) /
      1048576,
    retainedHeapMiBAfterGC: retained ? retained.usedSize / 1048576 : undefined,
    retainedBackingStorageMiBAfterGC: retained
      ? (retained.backingStorageSize ?? 0) / 1048576
      : undefined,
    estimatedCumulativeAllocationMiB: p.estimatedAllocatedBytes / 1048576,
    allocationSamples: p.samples,
  };
});
await writeFile(
  out,
  JSON.stringify(
    {
      ...source,
      phases,
      limitations: [
        "Local workerd observations only, with profiler overhead; not native Cloudflare peaks.",
        "Sampled maximum is a lower bound, not proof of the instantaneous peak.",
        "Cumulative allocation is a sampling estimate and excludes unobserved native allocations.",
        "Heap and backing storage are reported separately; do not assume either is the complete Worker memory charge.",
      ],
    },
    null,
    2,
  ),
);
console.table(phases);
