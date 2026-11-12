import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { build } from "../src/builder/build.js";
import { pageIndex } from "../src/builder/page-index.js";
const root = "work/full-flp";
await mkdir(root + "/indices", { recursive: true });
const training = JSON.parse(
  await readFile("bench/results/flp100k-queries.json", "utf8"),
).train.map((q: any) => q.q);
const wait = () => new Promise((r) => setTimeout(r, 5000));
for (;;) {
  const jobs = (await readdir(root + "/batches"))
    .filter((n) => n.endsWith(".json"))
    .sort();
  let worked = false;
  for (const name of jobs) {
    const job = JSON.parse(await readFile(root + "/batches/" + name, "utf8"));
    let published: any = { shards: {} };
    try {
      published = JSON.parse(await readFile(root + "/published.json", "utf8"));
    } catch {}
    const record = published.shards[job.part];
    if (record && !record.preview && record.inputSha256 === job.sha256) {
      await rm(`${root}/queue/${String(job.part).padStart(5, "0")}.jsonl`, {
        force: true,
      });
      continue;
    }
    const input = `${root}/queue/${String(job.part).padStart(5, "0")}.jsonl`,
      out = `${root}/indices/${String(job.part).padStart(5, "0")}`,
      staging = out + ".staging";
    const digest = createHash("sha256");
    for await (const b of createReadStream(input)) digest.update(b);
    if (digest.digest("hex") !== job.sha256)
      throw Error("Batch checksum mismatch");
    console.log("Building", job.part, job.documents, new Date().toISOString());
    if (
      !(await stat(staging + "/manifest.json").then(
        () => true,
        () => false,
      ))
    )
      await build({
        input,
        out: staging,
        pagedStaging: true,
        budget: 8 * 1048576,
        chunkDocs: 100,
      });
    if (
      !(await stat(out + "/manifest.json").then(
        () => true,
        () => false,
      ))
    )
      await pageIndex(staging, out, {
        localTables: true,
        budget: 8 * 1048576,
        hotDescriptors: 10000,
        embedPostings: true,
        inlineTiny: true,
        optimizationStep: 6,
        workload: training,
      });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/publish-shard.ts", out, String(job.part)],
        { stdio: "inherit" },
      );
      child.on("exit", (c) =>
        c === 0 ? resolve() : reject(Error("Publish failed " + c)),
      );
      child.on("error", reject);
    });
    published = JSON.parse(await readFile(root + "/published.json", "utf8"));
    published.shards[job.part].inputSha256 = job.sha256;
    await writeFile(
      root + "/published.json",
      JSON.stringify(published, null, 2),
    );
    await rm(input);
    await rm(staging, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
    console.log("Completed", job.part, new Date().toISOString());
    worked = true;
  }
  const complete = await readFile(root + "/import-complete.json", "utf8").then(
    JSON.parse,
    () => null,
  );
  if (complete) {
    const published = JSON.parse(
      await readFile(root + "/published.json", "utf8"),
    );
    const shards = Object.values(published.shards) as any[],
      documents = shards.reduce((n, s) => n + s.documents, 0);
    if (documents === complete.documents && shards.every((s) => !s.preview)) {
      const { url } = JSON.parse(
          await readFile(root + "/deployment.json", "utf8"),
        ),
        { INTERNAL_TOKEN: token } = JSON.parse(
          await readFile(root + "/secrets.json", "utf8"),
        );
      const status = {
        ...complete,
        partitions: shards.length,
        documents,
        phase: "Full official snapshot indexed",
        note: "All nonempty opinion texts from the official snapshot are indexed. Empty-text rows are reported separately.",
      };
      const res = await fetch(url + "/__status", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(status),
      });
      if (!res.ok) throw Error("Final status failed");
      await writeFile(
        root + "/deployment-complete.json",
        JSON.stringify(status, null, 2),
      );
      console.log("Full deployment complete", documents, url);
      break;
    }
  }
  if (!worked) await wait();
}
