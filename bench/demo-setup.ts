import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deploy } from "../scripts/deploy-demo.js";
const root = "work/demo-bench";
await mkdir(root, { recursive: true });
const file = root + "/snapshot.json";
let snapshot: any;
try {
  snapshot = JSON.parse(await readFile(file, "utf8"));
} catch {
  const state = JSON.parse(
    await readFile("work/full-flp/published.json", "utf8"),
  );
  snapshot = {
    capturedAt: new Date().toISOString(),
    shards: Object.values(state.shards)
      .filter((s: any) => !s.preview)
      .sort((a: any, b: any) => a.id - b.id),
    commit: "42e12d1",
    note: "Frozen published generations; later full-import partitions excluded.",
  };
  await writeFile(file, JSON.stringify(snapshot, null, 2));
}
const groups = [
  ...new Set<number>(snapshot.shards.map((s: any) => Math.floor(s.id / 32))),
].sort((a, b) => a - b);
for (const group of groups) {
  const shards = snapshot.shards.filter(
    (s: any) => Math.floor(s.id / 32) === group,
  );
  await deploy(
    `work-search-bench-group-${group}`,
    "demo/gateway.ts",
    {
      ROLE: "router",
      CHILDREN: JSON.stringify(
        shards.map((s: any, i: number) => ({
          binding: `CHILD_${i}`,
          min: s.id,
          max: s.id,
        })),
      ),
    },
    shards.map((s: any, i: number) => ({
      binding: `CHILD_${i}`,
      service: s.worker,
    })),
  );
}
const url = await deploy(
  "work-search-benchmark",
  "bench/demo-probe.ts",
  {
    ROLE: "root",
    CHILDREN: JSON.stringify(
      groups.map((g, i) => ({
        binding: `CHILD_${i}`,
        min: g * 32,
        max: g * 32 + 31,
      })),
    ),
  },
  groups.map((g, i) => ({
    binding: `CHILD_${i}`,
    service: `work-search-bench-group-${g}`,
  })),
);
await writeFile(root + "/deployment.json", JSON.stringify({ url }, null, 2));
console.log(
  "Frozen benchmark",
  snapshot.shards.length,
  "shards",
  snapshot.shards.reduce((n: number, s: any) => n + s.documents, 0),
  "opinions",
);
