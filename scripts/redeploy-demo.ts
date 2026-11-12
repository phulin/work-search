import { readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { deploy } from "./deploy-demo.js";
const root = "work/full-flp",
  { url } = JSON.parse(await readFile(root + "/deployment.json", "utf8")),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile(root + "/secrets.json", "utf8"),
  );
const suffix = new URL(url).hostname.split(".").slice(1).join(".");
async function locked(fn: () => Promise<void>) {
  const lock = root + "/publish.lock";
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(lock + "/pid", String(process.pid));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  try {
    await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
async function routers() {
  const state = JSON.parse(await readFile(root + "/published.json", "utf8")),
    members = Object.values(state.shards) as any[],
    groups = [...new Set(members.map((s) => Math.floor(s.id / 32)))].sort(
      (a, b) => a - b,
    );
  for (const g of groups) {
    const entries = members
      .filter((s) => Math.floor(s.id / 32) === g)
      .sort((a, b) => a.id - b.id);
    await deploy(
      `work-search-flp-group-${String(g).padStart(3, "0")}`,
      "demo/gateway.ts",
      {
        ROLE: "router",
        CHILDREN: JSON.stringify(
          entries.map((s, i) => ({
            binding: `CHILD_${i}`,
            min: s.id,
            max: s.id,
          })),
        ),
      },
      entries.map((s, i) => ({ binding: `CHILD_${i}`, service: s.worker })),
    );
  }
  await deploy(
    "work-search-demo",
    "demo/gateway.ts",
    {
      ROLE: "root",
      PERF_LEVEL: process.env.DEMO_OPT_STAGE ?? "3",
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
      service: `work-search-flp-group-${String(g).padStart(3, "0")}`,
    })),
  );
}
await locked(routers);
if (process.argv.includes("--upgrade-shards")) {
  const initial = JSON.parse(await readFile(root + "/published.json", "utf8"));
  await mkdir(root + "/redeploy", { recursive: true });
  for (const s of (Object.values(initial.shards) as any[]).sort(
    (a, b) => a.id - b.id,
  )) {
    const stats = (await fetch(`https://${s.worker}.${suffix}/internal/stats`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ q: "" }),
    }).then((r) => r.json())) as any;
    if (stats.apiVersion >= 2) continue;
    const r = await fetch(url + "/__index/" + s.generation, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw Error("Archive unavailable");
    const file = root + "/redeploy/" + s.id + ".bin";
    await writeFile(file, new Uint8Array(await r.arrayBuffer()));
    await locked(async () => {
      const saved = await readFile("data/bundle.bin");
      try {
        await copyFile(file, "data/bundle.bin");
        await deploy(s.worker, "demo/shard.ts", { SHARD_ID: String(s.id) });
      } finally {
        await writeFile("data/bundle.bin", saved);
      }
    });
    await rm(file);
    await new Promise((r) => setTimeout(r, 300));
  }
  await locked(routers);
}
