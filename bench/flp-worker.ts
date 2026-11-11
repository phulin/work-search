import { Miniflare } from "miniflare";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
const dry = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--dry-run",
    "--outdir",
    "dist",
  ],
  { encoding: "utf8" },
);
if (dry.status !== 0) throw Error(dry.stdout + dry.stderr);
const binaryName = (await readFile("dist/index.js", "utf8")).match(
  /["']\.\/([^"']+\.bin)["']/,
)![1];
const workload = JSON.parse(
  await readFile("bench/generated/flp/queries.json", "utf8"),
);
const queries = ["plain", "phrase", "proximity", "boolean"].flatMap((kind) =>
  workload.test.filter((q: any) => q.kind === kind).slice(0, 4),
);
const builds = JSON.parse(
    await readFile("bench/results/flp-builds.json", "utf8"),
  ),
  rows: any[] = [];
for (const budget of [8, 16, 32, 48]) {
  if (
    builds.find((b: any) => b.budgetMiB === budget && b.policy === "mixed")
      ?.error
  )
    continue;
  const root = `bench/generated/flp/${budget}-mixed`,
    m = JSON.parse(await readFile(root + "/manifest.json", "utf8")),
    bytes = await readFile(root + "/bundle.bin"),
    index = new BinaryIndex(bytes),
    storage = new FileStorage(root + "/objects");
  const expected = new Map();
  for (const q of queries) {
    const r = await search(index, storage, q.q, { exactTotal: true });
    expected.set(q.q, r.results);
  }
  const start = performance.now();
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: join(process.cwd(), "dist/index.js") },
      {
        type: "Data",
        path: join(process.cwd(), "dist", binaryName),
        contents: bytes,
      },
    ],
    modulesRoot: process.cwd(),
    scriptPath: join(process.cwd(), "dist/index.js"),
    r2Buckets: ["INDEX"],
    bindings: { DIAGNOSTICS: "true", CACHE_MIB: "4" },
  });
  try {
    await mf.ready;
    const startupWallMs = performance.now() - start,
      bucket = await mf.getR2Bucket("INDEX");
    for (const o of m.objects)
      if (o.kind === "frequencies" || o.kind === "positions")
        await bucket.put(o.key, await readFile(root + "/objects/" + o.key), {
          customMetadata: { generation: m.generation },
        });
    const samples = [];
    for (let pass = 0; pass < 3; pass++)
      for (const q of queries) {
        const t = performance.now(),
          response = await mf.dispatchFetch(
            "https://local/search?diagnostics=true&q=" +
              encodeURIComponent(q.q),
          );
        const body = (await response.json()) as any,
          ms = performance.now() - t;
        if (response.status !== 200)
          throw Error(
            `Worker query failed ${budget}/${q.q}: ${JSON.stringify(body)}`,
          );
        const oracle = expected.get(q.q);
        if (
          "total" in body ||
          JSON.stringify(body.results.map((h: any) => h.id)) !==
            JSON.stringify(oracle.map((h: any) => h.id)) ||
          body.results.some(
            (h: any, i: number) =>
              Math.abs(h.score - oracle[i].score) >
              1e-12 * Math.max(1, Math.abs(h.score)),
          )
        )
          throw Error("Worker results differ");
        samples.push({
          ...q,
          pass,
          ms,
          status: response.status,
          diagnostics: body.diagnostics,
        });
      }
    rows.push({ budget, policy: "mixed", startupWallMs, samples });
    await writeFile(
      "bench/results/flp-workerd.json",
      JSON.stringify(
        {
          local: true,
          description:
            "Miniflare/workerd HTTP with simulated R2, not deployed Cloudflare; 16 distinct evaluation queries per config, three mixed passes; response parse included, validation excluded",
          rows,
        },
        null,
        2,
      ),
    );
    console.log(
      `${budget} MiB: ${samples.length} real-text Worker responses checked`,
    );
  } finally {
    await mf.dispose();
  }
}
