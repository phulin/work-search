import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { OfflineObjects } from "../../src/columnar/offline.js";
import { benchmarkToken } from "./token.js";
const dir = "work/columnar-100k-lanes",
  root = JSON.parse(
    await readFile(
      "work/columnar-deploy/work-search-cws-v3-source/pairs-root.json",
      "utf8",
    ),
  ),
  temp = dir + "/restore-pairs";
await mkdir(temp + "/packs", { recursive: true });
const source = new OfflineObjects(temp, root, {
  url: "https://work-search-cws-upload.phulin.workers.dev",
  token: await benchmarkToken(),
});
try {
  for (let i = 0; i < root.objects.length; i++) {
    const o = root.objects[i];
    await writeFile(
      temp + "/packs/" + o.name,
      await source.read([i, 0, o.size]),
    );
    console.log("Restored validated pair object", o.name);
  }
} finally {
  await source.close();
}
await rename(dir + "/pairs/packs", dir + "/pairs/rejected-linear-packs");
await rename(temp + "/packs", dir + "/pairs/packs");
await writeFile(dir + "/pairs-root.json", JSON.stringify(root));
await writeFile(
  dir + "/pairs/manifest.json",
  JSON.stringify(
    {
      generation: root.generation,
      baseGeneration: root.baseGeneration,
      coverage: root.coverage,
      bytes: root.objects.reduce(
        (sum: number, o: { size: number }) => sum + o.size,
        0,
      ),
      restoredFrom: "v3 snapshot and checksum-validated immutable R2",
    },
    null,
    2,
  ),
);
await rm(dir + "/pairs/rejected-linear-packs", {
  recursive: true,
  force: true,
});
