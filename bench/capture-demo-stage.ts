import { readFile, writeFile } from "node:fs/promises";
import { root, remote } from "./demo-client.js";
import { demoWorkload } from "./demo-workload.js";
const stage = Number(process.env.DEMO_OPT_STAGE ?? 3),
  reference = JSON.parse(await readFile(root + "/live.json", "utf8")),
  rows: any[] = [];
for (let pass = 0; pass < 2; pass++)
  for (const q of demoWorkload) {
    const start = performance.now(),
      r = await remote("/search", { q: q.q, limit: 20 }),
      v: any = await r.json();
    if (v.status !== 200) throw Error(JSON.stringify(v));
    const want = reference.rows.find(
        (b: any) => b.q === q.q && b.pass === 0 && !b.page,
      ).body.results,
      got = v.body.results;
    if (
      got.length !== want.length ||
      got.some(
        (h: any, i: number) =>
          h.id !== want[i].id ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(want[i].score)),
      )
    )
      throw Error("Deployed ranking mismatch: " + q.q);
    for (let i = 0; i < got.length; i++)
      for (const field of ["title", "metadata"]) {
        if (field === "title" && got[i][field] !== want[i][field])
          throw Error("Title mismatch");
      }
    rows.push({ ...q, pass, ...v, endToEndMs: performance.now() - start });
    console.log(stage, pass, q.q, v.body.milliseconds);
    await writeFile(
      root + `/live-opt-stage${stage}.json`,
      JSON.stringify({ rows }, null, 2),
    );
  }
