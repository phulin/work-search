import { mkdir, readFile, writeFile } from "node:fs/promises";
import { root, snapshot, remote, object } from "./demo-client.js";
import { parallel } from "../src/storage/types.js";
import { demoWorkload } from "./demo-workload.js";

await mkdir(root + "/bundles", { recursive: true });
await parallel(snapshot.shards as any[], 4, async (s: any) => {
  const path = root + "/bundles/" + s.id + ".bin";
  try {
    await readFile(path);
    return;
  } catch {}
  await writeFile(path, await object(s.generation + "/bundle-0.bin"));
  console.log("Mirrored bundled index", s.id);
});
await writeFile(
  root + "/case-manifest.json",
  await object("demo-case-metadata.json"),
);
const queries = process.env.DEMO_QUERIES
  ? demoWorkload.slice(0, Number(process.env.DEMO_QUERIES))
  : demoWorkload;
const rows: any[] = [];
for (let pass = 0; pass < 3; pass++)
  for (const query of queries) {
    const start = performance.now(),
      r = await remote("/search", { q: query.q, limit: 20 }),
      sample: any = await r.json();
    const expectedDocuments = snapshot.shards.reduce(
      (n: number, s: any) => n + s.documents,
      0,
    );
    if (sample.body.documents !== expectedDocuments)
      throw Error("Frozen deployment document count changed");
    const actualGenerations = Object.assign(
      {},
      ...sample.trace.events
        .filter((e: any) => e.type === "service" && e.key.endsWith("/stats"))
        .map((e: any) => e.payload.generations),
    );
    if (
      snapshot.shards.some((s: any) => actualGenerations[s.id] !== s.generation)
    )
      throw Error("Frozen index generation changed");
    rows.push({
      ...query,
      pass,
      clientMs: performance.now() - start,
      ...sample,
    });
    console.log(
      "Live",
      pass,
      query.q,
      sample.trace.ms,
      sample.body.results?.length,
    );
    if (pass === 0 && query.kind === "plain-common" && sample.body.nextCursor) {
      const t = performance.now(),
        page: any = await (
          await remote("/search", {
            q: query.q,
            limit: 20,
            cursor: sample.body.nextCursor,
          })
        ).json();
      rows.push({
        ...query,
        pass,
        page: 2,
        clientMs: performance.now() - t,
        ...page,
      });
    }
    await writeFile(
      root + "/live.json",
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          snapshot: root + "/snapshot.json",
          rows,
        },
        null,
        2,
      ),
    );
  }
