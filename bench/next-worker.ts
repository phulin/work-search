import { Miniflare } from "miniflare";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
if (dry.status !== 0) throw new Error(dry.stdout + dry.stderr);
const binaryName = (await readFile("dist/index.js", "utf8")).match(
    /["\']\.\/([^"\']+\.bin)["\']/,
  )![1],
  rows = [];
for (const name of [
  ...[8, 16, 32, 48].map((budget) => `next-7r-${budget}`),
].filter((name) => !process.argv[2] || name === process.argv[2])) {
  const out = join("bench/generated", name),
    m = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
    start = performance.now();
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: join(process.cwd(), "dist/index.js") },
      {
        type: "Data",
        path: join(process.cwd(), "dist", binaryName),
        contents: await readFile(join(out, "bundle.bin")),
      },
    ],
    modulesRoot: process.cwd(),
    scriptPath: join(process.cwd(), "dist/index.js"),
    r2Buckets: ["INDEX"],
    bindings: { DIAGNOSTICS: "true", CACHE_MIB: "4" },
  });
  try {
    await mf.ready;
    const startupWallMs = performance.now() - start;
    const bucket = await mf.getR2Bucket("INDEX");
    for (const o of m.objects)
      if (o.kind === "frequencies" || o.kind === "positions")
        await bucket.put(o.key, await readFile(join(out, "objects", o.key)), {
          customMetadata: { generation: m.generation },
        });
    const samples = [];
    for (let pass = 0; pass < 3; pass++)
      for (const q of [
        "document",
        "category1",
        "word19999",
        "word0 word19999",
        '"search engine"',
        "document /s engine",
        "category1 /p word0",
        "(word10 OR word20) AND category1",
      ]) {
        const t = performance.now(),
          r = await mf.dispatchFetch(
            "http://local/search?diagnostics=true&total=false&q=" +
              encodeURIComponent(q),
          ),
          body = await r.json();
        samples.push({
          q,
          pass,
          status: r.status,
          ms: performance.now() - t,
          body,
        });
      }
    const { BinaryIndex } = await import("../src/format/index.js");
    const { FileStorage } = await import("../src/storage/filesystem.js");
    const { search } = await import("../src/query/engine.js");
    const nodeIndex = new BinaryIndex(await readFile(join(out, "bundle.bin"))),
      store = new FileStorage(join(out, "objects"));
    for (const q of new Set(samples.map((s) => s.q))) {
      const oracle = await search(nodeIndex, store, q, { exactTotal: true });
      const exactResponse = await mf.dispatchFetch(
        "https://local/search?total=true&q=" + encodeURIComponent(q),
      );
      const expected = (await exactResponse.json()) as any;
      if (
        exactResponse.status !== 200 ||
        expected.total !== oracle.total ||
        JSON.stringify(expected.results.map((h: any) => h.id)) !==
          JSON.stringify(oracle.results.map((h) => h.id)) ||
        expected.results.some(
          (h: any, i: number) =>
            Math.abs(h.score - oracle.results[i].score) >
            1e-12 * Math.max(1, Math.abs(h.score)),
        )
      )
        throw new Error("Worker exhaustive result differs from Node oracle");
      for (const s of samples.filter((s) => s.q === q)) {
        const body = s.body as any;
        if (
          s.status !== 200 ||
          "total" in body ||
          JSON.stringify(body.results) !== JSON.stringify(expected.results)
        )
          throw new Error(
            "Worker pruned results differ from exhaustive Worker: " + q,
          );
      }
    }
    rows.push({ name, startupWallMs, samples });
    console.log(
      name,
      Math.round(startupWallMs) + "ms local process/isolate startup",
    );
  } finally {
    await mf.dispose();
  }
}
await writeFile(
  "bench/results/next-workerd.json",
  JSON.stringify(
    {
      kind: "local Miniflare/workerd, includes process startup and IPC, no deployed network",
      rows,
    },
    null,
    2,
  ),
);
let report =
  "# Local workerd with pruning and cache\n\nMiniflare starts an actual workerd process and imports the Wrangler-generated ES module and binary Data module. These are local wall-clock measurements, including process creation/IPC. They do not measure Cloudflare isolate startup CPU or account limits. Twenty-four HTTP queries per configuration (eight types × three passes), sequential, no artificial latency, R2 simulated by Miniflare. Cache capacity 4 MiB, total=false; pass zero is cold and later passes are warm.\n\n|Configuration|Startup wall ms|HTTP P50 ms|HTTP P95 ms|Failed requests|\n|---|---:|---:|---:|---:|\n";
for (const r of rows) {
  const lat = r.samples.map((s) => s.ms).sort((a, b) => a - b);
  report += `|${r.name}|${r.startupWallMs.toFixed(1)}|${lat[Math.ceil(lat.length * 0.5) - 1].toFixed(2)}|${lat[Math.ceil(lat.length * 0.95) - 1].toFixed(2)}|${r.samples.filter((s) => s.status !== 200).length}|\n`;
}
report +=
  "\nRaw response diagnostics and exact samples are in results/next-workerd.json. Process startup wall time must not be compared to Cloudflare’s one-second global-scope CPU limit. Run a real deployment to validate that limit.\n";
await writeFile("bench/NEXT-WORKERD.md", report);
