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
const queries = [
  "(mootness OR standing) AND court",
  "(summary OR judgment) AND court",
  "(due OR process) AND court",
  "(court AND evidence) OR court",
  "(court OR judgment) AND (court OR evidence)",
  "summary OR judgment",
  "jurisdiction OR standing OR mootness OR ripeness",
  "summary OR judgment OR contract OR negligence",
  "qualified OR immunity OR probable OR warrant",
  "court OR judgment OR evidence OR claim",
  '"the" OR "of"',
  "court OR opinion OR appeal OR judgment OR plaintiff OR defendant OR claim OR evidence OR contract OR negligence OR immunity OR jurisdiction OR warrant OR process OR statute OR damages",
];
// Start cold with the wide OR query so the actual Worker exercises WAND before
// earlier Boolean requests populate the complete-list cache.
queries.unshift(queries.pop()!);
queries.splice(1, 0, "negligence");
const rows = [];
for (const budget of [8, 16, 32, 48]) {
  const root = `bench/generated/flp/${budget}-mixed`,
    m = JSON.parse(await readFile(root + "/manifest.json", "utf8")),
    bytes = await readFile(root + "/bundle.bin"),
    index = new BinaryIndex(bytes),
    storage = new FileStorage(root + "/objects");
  const expected = new Map();
  for (const q of queries)
    expected.set(
      q,
      (await search(index, storage, q, { exactTotal: true })).results,
    );
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
            "https://local/search?diagnostics=true&q=" + encodeURIComponent(q),
          );
        const body = (await response.json()) as any,
          ms = performance.now() - t,
          oracle = expected.get(q);
        if (
          response.status !== 200 ||
          "total" in body ||
          JSON.stringify(body.results.map((h: any) => h.id)) !==
            JSON.stringify(oracle.map((h: any) => h.id)) ||
          body.results.some(
            (h: any, i: number) =>
              Math.abs(h.score - oracle[i].score) >
              1e-12 * Math.max(1, Math.abs(h.score)),
          )
        )
          throw Error("Worker result differs: " + q);
        samples.push({
          q,
          pass,
          ms,
          status: response.status,
          diagnostics: body.diagnostics,
        });
      }
    if (!samples.some((s) => s.diagnostics.executor === "wand"))
      throw Error("Worker did not exercise WAND");
    if (!samples.some((s) => s.diagnostics.executor === "boolean-blocks"))
      throw Error("Worker did not exercise Boolean blocks");
    // Strict same-runtime check, including equal-score ties; count mode remains exact.
    for (const q of queries) {
      const response = await mf.dispatchFetch(
          "https://local/search?total=true&q=" + encodeURIComponent(q),
        ),
        exact = (await response.json()) as any;
      const r = await mf.dispatchFetch(
          "https://local/search?q=" + encodeURIComponent(q),
        ),
        actual = (await r.json()) as any;
      if (
        response.status !== 200 ||
        r.status !== 200 ||
        JSON.stringify(actual.results) !== JSON.stringify(exact.results)
      )
        throw Error("Worker exact-score mismatch");
    }
    rows.push({ budget, policy: "mixed", startupWallMs, samples });
    console.log(
      budget + " MiB: " + samples.length + " measured HTTP queries checked",
    );
    await writeFile(
      "bench/results/boolean-workerd.json",
      JSON.stringify(
        {
          local: true,
          description:
            "Local workerd/Miniflare R2 binding; not deployed Cloudflare; actual auto routing; strict same-runtime exhaustive comparison after timed passes",
          rows,
        },
        null,
        2,
      ),
    );
  } finally {
    await mf.dispose();
  }
}
