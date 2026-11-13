import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
for (const variant of process.argv.slice(2)) {
  const dir = `work/columnar-profile/${variant}`,
    out = `bench/results/columnar/profiles/${variant}`,
    observations = JSON.parse(await readFile(dir + "/requests.json", "utf8")),
    root = JSON.parse(await readFile(observations.dir + "/root.json", "utf8")),
    queries = [];
  await mkdir(out, { recursive: true });
  for (let i = 0; i < observations.queries.length; i++) {
    const cpuName = `${i}.cpuprofile.gz`,
      heapName = `${i}.heapprofile.gz`,
      cpu = JSON.parse(
        gunzipSync(await readFile(dir + "/" + cpuName)).toString(),
      ),
      heap = JSON.parse(
        gunzipSync(await readFile(dir + "/" + heapName)).toString(),
      ),
      nodes = new Map<number, any>(cpu.nodes.map((n: any) => [n.id, n])),
      self = new Map<string, number>();
    for (let j = 0; j < cpu.samples.length; j++) {
      const f = nodes.get(cpu.samples[j]).callFrame,
        k = `${f.functionName || "(anonymous)"}:${f.lineNumber + 1}`;
      self.set(k, (self.get(k) ?? 0) + cpu.timeDeltas[j]);
    }
    let sampledAllocationBytes = 0;
    const walk = (n: any) => {
      sampledAllocationBytes += n.selfSize ?? 0;
      for (const c of n.children ?? []) walk(c);
    };
    walk(heap.head);
    queries.push({
      q: observations.queries[i],
      cpuCalls: observations.rows
        .filter((r: any) => r.qi === i && r.phase === "cpu")
        .map((r: any) => ({ ms: r.ms, diagnostics: r.diagnostics })),
      sampledAllocationBytes,
      allocationCalls: observations.rows.filter(
        (r: any) => r.qi === i && r.phase === "allocation",
      ).length,
      selfCpuMicros: Object.fromEntries([...self].sort((a, b) => b[1] - a[1])),
    });
    await copyFile(dir + "/" + cpuName, out + "/" + cpuName);
    await copyFile(dir + "/" + heapName, out + "/" + heapName);
  }
  const report = {
    kind: observations.kind,
    generation: root.generation,
    corpusHash: root.corpusHash,
    documents: root.count,
    compiledSha256: createHash("sha256")
      .update(await readFile(dir + "/dist/entry.js"))
      .digest("hex"),
    queries,
    memory: observations.memory,
    maxObservedHeapAndBackingBytes: Math.max(
      ...observations.memory.map(
        (r: any) => (r.usedSize ?? 0) + (r.backingStorageSize ?? 0),
      ),
    ),
    caveats: [
      "Local workerd CPU/allocation attribution is not a native latency result.",
      "Heap sampling estimates cumulative allocation, including collected samples, rather than retained memory.",
      "Observed heap/backing peaks depend on sampling and GC timing. Forced collection was unavailable; neither native peak nor retained memory is established.",
    ],
  };
  await writeFile(out + "/summary.json", JSON.stringify(report, null, 2));
  console.log(
    variant,
    JSON.stringify({
      queries: queries.map((q) => ({
        q: q.q,
        allocationBytes: q.sampledAllocationBytes,
      })),
      maxObservedHeapAndBackingBytes: report.maxObservedHeapAndBackingBytes,
    }),
  );
}
