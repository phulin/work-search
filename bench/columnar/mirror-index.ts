import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Root } from "../../src/columnar/format.js";
import { LocalObjects } from "./local-storage.js";
import { benchmarkToken } from "./token.js";

const [dir, store = "work/columnar-local-data"] = process.argv.slice(2),
  width = Number(process.env.CWS_DOWNLOAD_CONCURRENCY ?? 4);
if (!dir || !Number.isInteger(width) || width < 1 || width > 8)
  throw Error("Usage: mirror-index.ts INDEX_DIR [LOCAL_DATA_DIR] [--wait]");
let root: Root;
for (;;) {
  try {
    root = JSON.parse(await readFile(dir + "/root.json", "utf8"));
    break;
  } catch (e: any) {
    if (e.code !== "ENOENT" || !process.argv.includes("--wait")) throw e;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
if (
  root.count !== 1000000 ||
  !root.directory ||
  !root.documentPackages?.locators
)
  throw Error("Local experiments require the complete 1M packet generation");
const source = new LocalObjects(root, store, {
  url: "https://work-search-cws-upload.phulin.workers.dev",
  token: await benchmarkToken(),
});
source.remoteEnabled = true;
const packages = await readFile(dir + "/documents.bin"),
  data = new DataView(
    packages.buffer,
    packages.byteOffset,
    packages.byteLength,
  ),
  groups = data.getUint32(8, true),
  keys = new Map(
    root.objects.map((o) => [o.key ?? `${root.generation}/${o.name}`, false]),
  );
for (let i = 0; i < groups; i++) {
  const digest = packages.subarray(32 + i * 48, 64 + i * 48).toString("hex");
  keys.set(digest + "/plan-0.bin", true);
}
await mkdir(store, { recursive: true });
const jobs = [...keys],
  started = performance.now();
let next = 0,
  completed = 0;
await Promise.all(
  Array.from({ length: width }, async () => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const [key, document] = job;
      await source.mirror(key);
      if (document) await source.packageMetadata(key);
      completed++;
      if (completed % 100 === 0)
        console.log(
          "Local immutable objects",
          completed,
          "/",
          jobs.length,
          "downloaded bytes",
          source.downloadedBytes,
        );
    }
  }),
);
const result = {
  generation: root.generation,
  analysis: root.analysis,
  corpusHash: root.corpusHash,
  documents: root.count,
  objects: completed,
  downloadedObjects: source.downloads,
  downloadedBytes: source.downloadedBytes,
  elapsedMs: performance.now() - started,
  finishedAt: new Date().toISOString(),
};
await writeFile(
  `${store}/${root.generation}.json`,
  JSON.stringify(result, null, 2),
);
console.log(result);
