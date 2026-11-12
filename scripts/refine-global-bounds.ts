import { mkdir, copyFile, link, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { addMicroPlans } from "../src/global/micro.js";
import { addDisplaySeeds } from "../src/global/display.js";
const source = process.argv[2],
  out = process.argv[3],
  docs = Number(process.argv[4] ?? 16),
  reserved = Number(process.argv[5] ?? 0);
if (!source || !out || resolve(source) === resolve(out))
  throw Error(
    "Usage: refine-global-bounds <source> <new directory> [cell docs=16] [reserved bundle bytes=0]",
  );
await mkdir(out);
await mkdir(out + "/packs");
const manifest = JSON.parse(await readFile(source + "/manifest.json", "utf8"));
for (const name of ["root.json", "manifest.json", "terms.sqlite"])
  await copyFile(
    source + "/" + name,
    out + "/" + name,
    constants.COPYFILE_FICLONE,
  );
for (const o of manifest.objects)
  await link(source + "/packs/" + o.name, out + "/packs/" + o.name);
console.log(
  "Cloned immutable source",
  manifest.generation,
  manifest.objects.length,
);
await addMicroPlans(out, docs);
const result = await addDisplaySeeds(out, reserved);
console.log(
  JSON.stringify({
    generation: result.generation,
    scoreCellDocs: docs,
    microMs: result.microMs,
    objects: result.objects.length,
    addedBytes: result.objects
      .slice(manifest.objects.length)
      .reduce((n: number, o: { size: number }) => n + o.size, 0),
    roots: result.roots.map(
      (r: { budget: number; displayBytes: number; displaySha256: string }) => ({
        budget: r.budget,
        bundleBytes: r.displayBytes,
        withAuxiliaryBytes: r.displayBytes + reserved,
        sha256: r.displaySha256,
      }),
    ),
  }),
);
