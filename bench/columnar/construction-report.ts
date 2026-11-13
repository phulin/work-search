import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { basename } from "node:path";
const out = "bench/results/columnar/construction";
await mkdir(out, { recursive: true });
for (const dir of process.argv.slice(2)) {
  const label = basename(dir),
    manifest = JSON.parse(await readFile(dir + "/manifest.json", "utf8")),
    rows = (await readFile(dir + "/requests.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    phases = [];
  for (const path of ["/ingest", "/merge", "/postings", "/documents"]) {
    const selected = rows.filter((r) => r.path === path && !r.reused),
      sum = (f: (r: any) => number) =>
        selected.reduce((n, r) => n + (f(r) || 0), 0);
    phases.push({
      path,
      tasks: selected.length,
      clientMs: sum((r) => r.clientMs),
      workerWallMs: sum((r) => r.telemetry.wallMs),
      sourceRequests: sum((r) => r.telemetry.requests),
      sourceBytes: sum((r) => r.telemetry.bytes),
      dictionaryRequests: sum((r) => r.work?.dictionaryRequests),
      dictionaryBytes: sum((r) => r.work?.dictionaryBytes),
      stageRequests: sum((r) => r.writesAndMergeReads),
      stageBytes: sum((r) => r.writeAndMergeBytes),
    });
  }
  const active = rows.filter(
      (r) => phases.some((p) => p.path === r.path) && !r.reused,
    ),
    buildMs =
      Math.max(...active.map((r) => Date.parse(r.at))) -
      Math.min(...active.map((r) => Date.parse(r.at) - r.clientMs));
  await writeFile(
    `${out}/${label}.json`,
    JSON.stringify(
      {
        manifest,
        buildMs,
        phases,
        limitations: [
          "Build time excludes deployment and final publication checks.",
          "Source, stage, and dictionary bytes count transfers, including repeated reads.",
          "Successful live execution establishes that the sampled tasks were admitted; native peak or retained memory is not available here.",
        ],
      },
      null,
      2,
    ),
  );
  await copyFile(dir + "/requests.jsonl", `${out}/${label}-requests.jsonl`);
  await copyFile(dir + "/root.json", `${out}/${label}-root.json`);
  console.log(
    label,
    Math.round(buildMs),
    "ms",
    manifest.bytes,
    "serving bytes",
  );
}
await copyFile(
  "work/columnar-worker-build/source-root.json",
  out + "/source-root.json",
);
