import { packOpinions } from "../src/content/pack.js";
import { openIndex } from "../src/format/paged.js";
import { readFile, stat, rm } from "node:fs/promises";
import { build } from "../src/builder/build.js";
import { pageIndex } from "../src/builder/page-index.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
const part = Number(process.argv[2]),
  root = "work/full-flp",
  name = String(part).padStart(5, "0"),
  job = JSON.parse(await readFile(root + "/batches/" + name + ".json", "utf8")),
  input = root + "/queue/" + name + ".jsonl",
  out = root + "/indices/" + name,
  staging = out + ".staging";
const digest = createHash("sha256");
for await (const b of createReadStream(input)) digest.update(b);
if (digest.digest("hex") !== job.sha256) throw Error("Input checksum mismatch");
if (
  !(await stat(staging + "/manifest.json").then(
    () => true,
    () => false,
  ))
) {
  await rm(staging, { recursive: true, force: true });
  await build({
    input,
    out: staging,
    pagedStaging: true,
    budget: 8 * 1048576,
    chunkDocs: 100,
  });
}
const workload = JSON.parse(
  await readFile("bench/results/flp100k-queries.json", "utf8"),
).train.map((q: any) => q.q);
if (
  !(await stat(out + "/manifest.json").then(
    () => true,
    () => false,
  ))
) {
  await rm(out, { recursive: true, force: true });
  await pageIndex(staging, out, {
    localTables: true,
    budget: 8 * 1048576,
    hotDescriptors: 10000,
    embedPostings: true,
    inlineTiny: true,
    optimizationStep: 6,
    workload,
  });
}

if (
  !(await stat(out + "/viewer/viewer-manifest.json").then(
    () => true,
    () => false,
  ))
) {
  const index = openIndex(await readFile(out + "/bundle.bin"));
  await packOpinions(
    input,
    out + "/viewer",
    index.count,
    (i) => index.document(i).id,
  );
}
