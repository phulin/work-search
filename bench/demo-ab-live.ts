import { readFile, writeFile } from "node:fs/promises";
import { deploy } from "../scripts/deploy-demo.js";
import { parallel } from "../src/storage/types.js";
import { demoWorkload } from "./demo-workload.js";
const root = "work/demo-bench",
  reuse = process.argv.includes("--run-only"),
  state = reuse
    ? {
        shards: JSON.parse(await readFile(root + "/ab-snapshot.json", "utf8"))
          .shards,
      }
    : JSON.parse(await readFile("work/full-flp/published.json", "utf8")),
  shards = (Object.values(state.shards) as any[])
    .filter((s) => !s.preview)
    .sort((a, b) => a.id - b.id),
  groups = [...new Set<number>(shards.map((s) => Math.floor(s.id / 32)))],
  token = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  ).INTERNAL_TOKEN;
const snapshot = reuse
  ? JSON.parse(await readFile(root + "/ab-snapshot.json", "utf8"))
  : { capturedAt: new Date().toISOString(), shards };
await writeFile(root + "/ab-snapshot.json", JSON.stringify(snapshot, null, 2));
if (!reuse)
  await parallel(groups, 3, async (g) => {
    const members = shards.filter((s) => Math.floor(s.id / 32) === g);
    await deploy(
      `work-search-ab-group-${g}`,
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
const urls = await parallel(
  [0, 3],
  2,
  async (level) =>
    await deploy(
      `work-search-ab-level-${level}`,
      "bench/demo-probe.ts",
      {
        ROLE: "root",
        PERF_LEVEL: String(level),
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
        service: `work-search-ab-group-${g}`,
      })),
    ),
);
// New workers.dev routes may take a moment to activate. Empty queries warm no postings.
for (const url of urls) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url! + "/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ q: "" }),
    });
    const text = await r.text();
    if (r.status === 400 && text.startsWith("{")) break;
    if (attempt >= 12) throw Error("A/B Worker not ready: " + r.status);
    await new Promise((r) =>
      setTimeout(r, Math.min(5000, 1000 * (attempt + 1))),
    );
  }
}
const queries = demoWorkload.filter((_, i) =>
    [0, 2, 4, 6, 8, 9, 12, 15].includes(i),
  ),
  rows: any[] = [];
for (let pass = 0; pass < 2; pass++)
  for (const [qi, q] of queries.entries()) {
    let reference: any;
    for (const level of (pass + qi) % 2 ? [3, 0] : [0, 3]) {
      const start = performance.now(),
        r = await fetch(urls[level === 0 ? 0 : 1]! + "/search", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ q: q.q, limit: 20 }),
        }),
        v: any = await r.json();
      if (!r.ok || v.status !== 200) throw Error(JSON.stringify(v));
      const results = v.body.results.map((h: any) => ({
        id: h.id,
        score: h.score,
      }));
      if (
        reference &&
        (results.length !== reference.length ||
          results.some(
            (h: any, i: number) =>
              h.id !== reference[i].id ||
              Math.abs(h.score - reference[i].score) >
                1e-11 * Math.max(1, Math.abs(h.score)),
          ))
      )
        throw Error("A/B ranking mismatch " + q.q);
      reference = results;
      rows.push({
        ...q,
        level,
        pass,
        ms: v.body.milliseconds,
        clientMs: performance.now() - start,
        documents: v.body.documents,
        colo: v.trace.colo,
        results,
      });
      console.log(pass, level, q.q, v.body.milliseconds);
      await writeFile(
        root + "/ab-live.json",
        JSON.stringify(
          {
            kind: "Native interleaved A/B, identical frozen full-size shard memberships, same leaf Workers with possible shared-cache effects, balanced request order; private gateway tracing; not randomized user traffic",
            snapshot,
            rows,
          },
          null,
          2,
        ),
      );
    }
  }
