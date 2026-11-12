import { Miniflare } from "miniflare";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
const packed = spawnSync(
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
if (packed.status) throw Error(packed.stdout + packed.stderr);
const code = await readFile("dist/index.js", "utf8"),
  name = code.match(/["']\.\/([^"']+\.bin)["']/)![1],
  rows = [];
for (const design of (
  process.env.PAGED_DESIGNS ?? "32-mixed,48-mixed,paged"
).split(",")) {
  const root = `bench/generated/flp-100000/${design === "hybrid-adaptive" ? "hybrid-tables" : design}`,
    bytes = await readFile(root + "/bundle.bin"),
    manifest = JSON.parse(await readFile(root + "/manifest.json", "utf8"));
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: join(process.cwd(), "dist/index.js") },
      {
        type: "Data",
        path: join(process.cwd(), "dist", name),
        contents: bytes,
      },
    ],
    modulesRoot: process.cwd(),
    scriptPath: join(process.cwd(), "dist/index.js"),
    r2Buckets: ["INDEX"],
    bindings: { DIAGNOSTICS: "true", CACHE_MIB: "4" },
  });
  try {
    const started = performance.now();
    await mf.ready;
    const startupMs = performance.now() - started,
      bucket = await mf.getR2Bucket("INDEX");
    for (const o of manifest.objects)
      await bucket.put(o.key, await readFile(root + "/objects/" + o.key), {
        customMetadata: { generation: manifest.generation },
      });
    const idx = openIndex(bytes),
      storage = new FileStorage(root + "/objects");
    for (let pass = 0; pass < 2; pass++)
      for (const q of [
        "summary judgment",
        "court OR evidence",
        "(standing OR mootness) AND court",
        '"summary judgment"',
        "qualified /25 immunity",
        "café",
        "nonexistentzzzz",
      ]) {
        const start = performance.now(),
          response = await mf.dispatchFetch(
            "https://test/search?diagnostics=true&q=" + encodeURIComponent(q),
          ),
          got: any = await response.json(),
          ms = performance.now() - start;
        if (response.status !== 200) throw Error(JSON.stringify(got));
        const want = await search(idx, storage, q, { exactTotal: true });
        if (
          got.results.length !== want.results.length ||
          got.results.some(
            (h: any, i: number) =>
              h.id !== want.results[i].id ||
              Math.abs(h.score - want.results[i].score) > 1e-12,
          )
        )
          throw Error("Worker mismatch " + q);
        rows.push({
          design,
          pass,
          q,
          ms,
          startupMs,
          diagnostics: got.diagnostics,
        });
      }
  } finally {
    await mf.dispose();
  }
}
await writeFile(
  `bench/results/${process.env.PAGED_PREFIX ?? "paged"}-workerd.json`,
  JSON.stringify(rows, null, 2) + "\n",
);
console.log(`${rows.length} real local Worker HTTP searches verified`);
