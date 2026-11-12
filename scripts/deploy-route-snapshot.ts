import { readFile } from "node:fs/promises";
import { decodeRoutes } from "../src/format/routes.js";
import { deploy } from "./deploy-demo.js";
import { parallel } from "../src/storage/types.js";
const routes = decodeRoutes(await readFile("data/global-routes.bin"))!;
if (!routes.stats) throw Error("Build directory with corpus statistics first");
const published = JSON.parse(
  await readFile("work/full-flp/published.json", "utf8"),
).shards;
const shards = Object.entries(routes.shards).map(([id, generation]) => {
  const shard = published[id];
  if (shard?.generation !== generation)
    throw Error("Directory no longer matches deployed leaf " + id);
  return shard;
});
const groups = [
  ...new Set<number>(shards.map((s) => Math.floor(s.id / 32))),
].sort((a, b) => a - b);
if (!process.env.SNAPSHOT_SKIP_ROUTERS)
  await parallel(groups, 3, async (g) => {
    const members = shards
      .filter((s) => Math.floor(s.id / 32) === g)
      .sort((a, b) => a.id - b.id);
    await deploy(
      `ws-snap-${routes.generation.slice(0, 12)}-${g}`,
      "demo/gateway.ts",
      {
        ROLE: "router",
        CHILDREN: JSON.stringify(
          members.map((s, i) => ({
            binding: `PART_${i}`,
            min: s.id,
            max: s.id,
          })),
        ),
      },
      members.map((s, i) => ({ binding: `PART_${i}`, service: s.worker })),
    );
  });
await deploy(
  process.env.SNAPSHOT_WORKER ?? "work-search-snapshot",
  process.env.SNAPSHOT_PROBE ? "bench/demo-probe.ts" : "demo/gateway.ts",
  {
    ROLE: "root",
    PERF_LEVEL: process.env.DEMO_OPT_STAGE ?? "4",
    ROUTE_SNAPSHOT: routes.generation,
    CHILDREN: JSON.stringify(
      groups.map((g, i) => ({
        binding: `PART_${i}`,
        min: g * 32,
        max: g * 32 + 31,
      })),
    ),
  },
  groups.map((g, i) => ({
    binding: `PART_${i}`,
    service: `ws-snap-${routes.generation.slice(0, 12)}-${g}`,
  })),
);
