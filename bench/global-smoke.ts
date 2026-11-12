import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
const token = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  ).INTERNAL_TOKEN,
  name = process.env.GLOBAL_SMOKE_WORKER ?? "work-search-global-reuse",
  oracle = JSON.parse(
    await readFile("work/global-bench/competitive-oracle.json", "utf8"),
  ),
  rows: any[] = [];
for (const q of [
  "court",
  "summary judgment",
  '"clear and convincing evidence"',
  '"court cause number 2010"',
]) {
  const start = performance.now(),
    response = await fetch(`https://${name}.phulin.workers.dev/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ q, resetMemory: true }),
    }),
    body: any = await response.json(),
    expected = oracle[q];
  if (
    !response.ok ||
    body.results.length !== expected.length ||
    body.results.some(
      (r: any, i: number) =>
        r.id !== expected[i].id ||
        Math.abs(r.score - expected[i].score) >
          1e-11 * Math.max(1, Math.abs(expected[i].score)),
    )
  )
    throw Error("Native smoke ranking mismatch " + q);
  rows.push({
    q,
    ms: performance.now() - start,
    diagnostics: body.diagnostics,
    colo: body.colo,
  });
}
await writeFile(
  "work/global-bench/native-reuse-smoke.json",
  JSON.stringify({
    kind: "Reset isolate memory; shared cache state uncontrolled; four individual final API probes, not latency percentiles",
    rows,
  }),
);
const source = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  ),
  q = "state OR united",
  expected = (
    await search(
      source,
      new FileStorage("bench/generated/flp-100000/source/objects"),
      q,
      {
        field: "title",
        titleBoost: 0,
        limit: 40,
        metadata: false,
        executor: "materialized",
      },
    )
  ).results,
  pages: any[] = [];
let after: { score: number; doc: number } | undefined,
  generation: string | undefined;
for (let page = 0; page < 2; page++) {
  const response = await fetch(
      "https://work-search-global-demo.phulin.workers.dev/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q,
          limit: 20,
          field: "title",
          titleBoost: 0,
          metadata: false,
          snippets: false,
          after,
          generation,
        }),
      },
    ),
    body: any = await response.json();
  if (
    !response.ok ||
    JSON.stringify(body.results.map((r: any) => r.id)) !==
      JSON.stringify(
        expected.slice(page * 20, (page + 1) * 20).map((r) => r.id),
      )
  )
    throw Error("Native zero-score pagination mismatch");
  pages.push(
    body.results.map((r: any) => ({ id: r.id, score: r.score, doc: r.doc })),
  );
  const last = body.results.at(-1)!;
  after = { score: last.score, doc: last.doc };
  generation = body.generation;
}
await writeFile(
  "work/global-bench/native-tie-smoke.json",
  JSON.stringify({
    kind: "Final native public API, field=title titleBoost=0, two 20-result pages checked against materialized source",
    q,
    pages,
  }),
);
console.log("Verified final native ranking, zero-score ties and pagination");
