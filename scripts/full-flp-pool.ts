import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
const root = "work/full-flp";
await mkdir(root + "/indices", { recursive: true });
const active = new Map<number, Promise<void>>();
let fatal: unknown;
const run = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("exit", (c) =>
      c === 0 ? resolve() : reject(Error("Child exited " + c)),
    );
    child.on("error", reject);
  });
async function processPart(job: any) {
  const name = String(job.part).padStart(5, "0");
  console.log("Building", job.part, job.documents, new Date().toISOString());
  await run([
    "--max-old-space-size=" + (process.env.FLP_HEAP_MIB ?? "3072"),
    "--import",
    "tsx",
    "scripts/build-full-part.ts",
    String(job.part),
  ]);
  await run([
    "--import",
    "tsx",
    "scripts/publish-shard.ts",
    root + "/indices/" + name,
    String(job.part),
  ]);
  await writeFile(root + "/batches/" + name + ".processed", job.sha256);
  await rm(root + "/queue/" + name + ".jsonl", { force: true });
  await rm(root + "/indices/" + name, { recursive: true, force: true });
  await rm(root + "/indices/" + name + ".staging", {
    recursive: true,
    force: true,
  });
  console.log("Completed", job.part, new Date().toISOString());
}
for (;;) {
  if (fatal) {
    await Promise.allSettled(active.values());
    throw fatal;
  }
  const files = (await readdir(root + "/batches"))
    .filter((n) => n.endsWith(".json"))
    .sort();
  for (const file of files) {
    if (active.size >= Number(process.env.FLP_BUILDERS ?? 3)) break;
    const job = JSON.parse(await readFile(root + "/batches/" + file, "utf8"));
    if (active.has(job.part)) continue;
    const done = await readFile(
      root + "/batches/" + file.replace(".json", ".processed"),
      "utf8",
    ).catch(() => "");
    let published: any = { shards: {} };
    try {
      published = JSON.parse(await readFile(root + "/published.json", "utf8"));
    } catch {}
    if (
      done === job.sha256 ||
      (!published.shards[job.part]?.preview &&
        published.shards[job.part]?.inputSha256 === job.sha256)
    ) {
      await rm(root + "/queue/" + file.replace(".json", ".jsonl"), {
        force: true,
      });
      continue;
    }
    const promise = processPart(job)
      .catch((e) => {
        fatal = e;
        console.error(e);
      })
      .finally(() => active.delete(job.part));
    active.set(job.part, promise);
  }
  const finished = await readFile(root + "/import-complete.json", "utf8").then(
    JSON.parse,
    () => null,
  );
  if (finished && !active.size) {
    const state = JSON.parse(await readFile(root + "/published.json", "utf8")),
      shards = Object.values(state.shards) as any[],
      documents = shards.reduce((n, s) => n + s.documents, 0);
    if (documents === finished.documents && shards.every((s) => !s.preview)) {
      const { url } = JSON.parse(
          await readFile(root + "/deployment.json", "utf8"),
        ),
        { INTERNAL_TOKEN: token } = JSON.parse(
          await readFile(root + "/secrets.json", "utf8"),
        );
      const status = {
        ...finished,
        documents,
        partitions: shards.length,
        phase: "Full official snapshot indexed",
        note: "All nonempty opinion texts in the official snapshot are searchable.",
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
  await new Promise((r) => setTimeout(r, 2000));
}
