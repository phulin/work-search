import { writeFile } from "node:fs/promises";
import { root, remote } from "./demo-client.js";
import { demoWorkload } from "./demo-workload.js";
import { parallel } from "../src/storage/types.js";
const rows: any[] = [];
for (const concurrency of [1, 4]) {
  const start = performance.now();
  const samples = await parallel(demoWorkload, concurrency, async (q) => {
    const t = performance.now(),
      sample: any = await (
        await remote("/search", { q: q.q, limit: 20 })
      ).json();
    return { ...q, clientMs: performance.now() - t, ...sample };
  });
  rows.push({ concurrency, elapsedMs: performance.now() - start, samples });
  await writeFile(
    root + "/load.json",
    JSON.stringify(
      {
        kind: "Actual deployed frozen benchmark graph, fixed 16-query closed-loop burst; not sustained fleet capacity",
        rows,
      },
      null,
      2,
    ),
  );
  console.log("Live load", concurrency, performance.now() - start);
}
