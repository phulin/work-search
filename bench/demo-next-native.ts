import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { demoWorkload } from "./demo-workload.js";
import { parallel } from "../src/storage/types.js";
import { uploadCards } from "../scripts/upload-cards.js";
import { snapshot } from "./demo-client.js";
const root = "work/demo-bench";
const token = JSON.parse(
  await readFile("work/full-flp/secrets.json", "utf8"),
).INTERNAL_TOKEN;
if (!process.argv.includes("--run-only")) {
  await parallel(snapshot.shards, 3, async (s: any) =>
    uploadCards(root + "/passages/" + s.id, true),
  );
  const savedRoot = await readFile("data/global-routes.bin");
  try {
    await writeFile(
      "data/global-routes.bin",
      await readFile(root + "/routes/root.bin"),
    );
    for (const level of [3, 4, 5])
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/deploy-route-snapshot.ts"],
          {
            stdio: "inherit",
            env: {
              ...process.env,
              SNAPSHOT_PROBE: "1",
              SNAPSHOT_WORKER: `work-search-next-${level}`,
              DEMO_OPT_STAGE: String(level),
            },
          },
        );
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(Error("Deploy failed")),
        );
      });
  } finally {
    await writeFile("data/global-routes.bin", savedRoot);
  }
}
const rows: any[] = [];
const suffix = new URL(
  JSON.parse(await readFile("work/full-flp/deployment.json", "utf8")).url,
).hostname
  .split(".")
  .slice(1)
  .join(".");
for (let pass = 0; pass < 6; pass++)
  for (const [qi, q] of demoWorkload.entries()) {
    let reference: any;
    for (const level of [
      [3, 4, 5],
      [4, 5, 3],
      [5, 3, 4],
      [5, 4, 3],
      [4, 3, 5],
      [3, 5, 4],
    ][(pass + qi) % 6]) {
      const start = performance.now();
      const r = await fetch(
        `https://work-search-next-${level}.${suffix}/search`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ q: q.q, limit: 20 }),
        },
      );
      const v: any = await r.json();
      if (!r.ok || v.status !== 200) throw Error(JSON.stringify(v));
      const hits = v.body.results.map((h: any) => ({
        id: h.id,
        score: h.score,
      }));
      if (
        reference &&
        (reference.length !== hits.length ||
          hits.some(
            (h: any, i: number) =>
              h.id !== reference[i].id ||
              Math.abs(h.score - reference[i].score) >
                1e-11 * Math.max(1, Math.abs(h.score)),
          ))
      )
        throw Error("Ranking changed " + q.q);
      reference = hits;
      rows.push({
        ...q,
        level,
        pass,
        ms: v.body.milliseconds,
        clientMs: performance.now() - start,
        results: hits,
        trace: v.trace,
      });
      console.log(pass, level, q.q, v.body.milliseconds);
      await writeFile(
        root + "/next-native.json",
        JSON.stringify({
          kind: "Interleaved native frozen-67 snapshot comparison; same leaves may share caches; targeted passages backfilled for recorded benchmark hits only",
          snapshot,
          rows,
        }),
      );
    }
  }
