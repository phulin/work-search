import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
  rename,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { packOpinions } from "../src/content/pack.js";
import { openIndex } from "../src/format/paged.js";
const root = "work/full-flp";
await mkdir(root + "/viewer-builds", { recursive: true });
await mkdir(root + "/viewer-jobs", { recursive: true });
const { url } = JSON.parse(await readFile(root + "/deployment.json", "utf8")),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile(root + "/secrets.json", "utf8"),
  );
for (;;) {
  let worked = false;
  for (const name of (await readdir(root + "/viewer-jobs"))
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    if (
      await readFile(
        root + "/viewer-jobs/" + name.replace(".json", ".processed"),
        "utf8",
      ).then(
        () => true,
        () => false,
      )
    )
      continue;
    const job = JSON.parse(
      await readFile(root + "/viewer-jobs/" + name, "utf8"),
    );
    let published = JSON.parse(
        await readFile(root + "/published.json", "utf8"),
      ),
      record = published.shards[job.part];
    if (!record || record.preview) continue;
    const out = root + "/viewer-builds/" + String(job.part).padStart(5, "0");
    await mkdir(out, { recursive: true });
    const response = await fetch(url + "/__index/" + record.generation, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw Error("Index bundle download failed " + response.status);
    await pipeline(
      Readable.fromWeb(response.body as any),
      createWriteStream(out + "/bundle.bin"),
    );
    const index = openIndex(await readFile(out + "/bundle.bin"));
    if (index.generation !== record.generation)
      throw Error("Viewer generation mismatch");
    const input = root + "/viewer-queue/" + name.replace(".json", ".jsonl");
    const manifest = await packOpinions(
      input,
      out,
      index.count,
      (i) => index.document(i).id,
    );
    for (const o of manifest.objects) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await fetch(
          url +
            "/__upload/" +
            encodeURIComponent(record.generation + "/" + o.name),
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              "content-length": String(o.size),
              "x-sha256": o.sha256,
            },
            body: createReadStream(out + "/" + o.name),
            duplex: "half",
          } as any,
        );
        if (r.ok) break;
        if (attempt === 4) throw Error("Viewer upload " + r.status);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const lock = root + "/publish.lock";
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(lock + "/pid", String(process.pid));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    try {
      published = JSON.parse(await readFile(root + "/published.json", "utf8"));
      if (published.shards[job.part].generation !== record.generation)
        throw Error("Index changed during viewer backfill");
      published.shards[job.part].viewerAvailable = true;
      await writeFile(
        root + "/published.tmp",
        JSON.stringify(published, null, 2),
      );
      await rename(root + "/published.tmp", root + "/published.json");
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
    await writeFile(
      root + "/viewer-jobs/" + name.replace(".json", ".processed"),
      record.generation,
    );
    await rm(input);
    await rm(out, { recursive: true, force: true });
    console.log(
      "Viewer published",
      job.part,
      index.count,
      new Date().toISOString(),
    );
    worked = true;
  }
  const complete = await readFile(
    root + "/viewer-backfill-complete.json",
    "utf8",
  ).then(JSON.parse, () => null);
  if (complete) {
    const done = (await readdir(root + "/viewer-jobs")).filter((n) =>
      n.endsWith(".processed"),
    ).length;
    if (done === complete.batches) {
      console.log("Viewer backfill complete", done);
      break;
    }
  }
  if (!worked) await new Promise((r) => setTimeout(r, 3000));
}
