import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { basename } from "node:path";
const out = "bench/results/columnar/construction";
await mkdir(out, { recursive: true });
for (const dir of process.argv.slice(2)) {
  const label = basename(dir),
    manifest = await readFile(dir + "/manifest.json", "utf8").then(
      JSON.parse,
      async () => {
        const state = JSON.parse(await readFile(dir + "/build.json", "utf8"));
        return {
          build: state.build,
          code: state.code,
          sourceHash: state.sourceHash,
          count: state.count,
          startedAt: state.startedAt,
          complete: false,
          ingested: state.ingests.reduce(
            (n: number, j: any) => n + j.next - j.first,
            0,
          ),
          completedPostingJobs: state.postings.filter((j: any) => j.done)
            .length,
          completedDocuments: state.documents.reduce(
            (n: number, j: any) =>
              n + (j.next ?? j.range.first) - j.range.first,
            0,
          ),
          note: "Stopped diagnostic build; phase totals cover completed requests only, not a complete-build latency.",
        };
      },
    ),
    rows = (await readFile(dir + "/requests.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    phases: any[] = [];
  const cpuFiles = (await readdir(dir)).filter((f) =>
      /^cpu-.*\.json\.gz$/.test(f),
    ),
    native: any[] = [];
  for (const file of cpuFiles) {
    const bytes = await readFile(dir + "/" + file);
    native.push(...JSON.parse(gunzipSync(bytes).toString()).rows);
    await writeFile(`${out}/${label}-${file}`, bytes);
  }
  for (const path of [
    "/ingest",
    "/merge",
    "/postings",
    "/routing",
    "/vocabulary",
    "/documents",
    "/verify",
    "/publish",
  ]) {
    const selected = rows.filter((r) => r.path === path && !r.reused),
      sum = (f: (r: any) => number) =>
        selected.reduce((n, r) => n + (f(r) || 0), 0);
    const cpu = native
      .filter((r) => r.path === path && Number.isFinite(r.cpuMs))
      .map((r) => r.cpuMs)
      .sort((a, b) => a - b);
    phases.push({
      path,
      tasks: selected.length,
      elapsedMs: selected.length
        ? Math.max(...selected.map((r) => Date.parse(r.at))) -
          Math.min(...selected.map((r) => Date.parse(r.at) - r.clientMs))
        : 0,
      clientMs: sum((r) => r.clientMs),
      workerWallMs: sum((r) => r.telemetry.wallMs),
      sampledNativeCpu: cpu.length
        ? {
            n: cpu.length,
            sumMs: cpu.reduce((a, b) => a + b, 0),
            p50: cpu[Math.ceil(cpu.length * 0.5) - 1],
            p95: cpu[Math.ceil(cpu.length * 0.95) - 1],
            max: cpu.at(-1),
          }
        : undefined,
      sourceRequests: sum((r) => r.telemetry.requests),
      sourceBytes: sum((r) => r.telemetry.bytes),
      dictionaryRequests: sum((r) => r.work?.dictionaryRequests),
      dictionaryBytes: sum((r) => r.work?.dictionaryBytes),
      stageRequests: sum((r) => r.writesAndMergeReads),
      stageBytes: sum((r) => r.writeAndMergeBytes),
    });
  }
  const active = rows.filter(
      (r) =>
        r.path !== "/publish" &&
        r.path !== "/verify" &&
        phases.some((p) => p.path === r.path) &&
        !r.reused,
    ),
    buildMs =
      Math.max(...active.map((r) => Date.parse(r.at))) -
      Math.min(...active.map((r) => Date.parse(r.at) - r.clientMs));
  await writeFile(
    `${out}/${label}.json`,
    JSON.stringify(
      {
        manifest,
        completeMs: manifest.finishedAt
          ? Date.parse(manifest.finishedAt) - Date.parse(manifest.startedAt)
          : undefined,
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
