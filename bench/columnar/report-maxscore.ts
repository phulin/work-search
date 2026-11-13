import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const [prefix, out, controlFile] = process.argv.slice(2);
if (!prefix || !out) throw Error("Usage: report-maxscore.ts PREFIX OUTPUT");
const runs = [];
for (const name of (await readdir("work/columnar-bench"))
  .filter((n) => n.startsWith(prefix + "-") && /-s\d+\.json\.gz$/.test(n))
  .sort()) {
  const run = JSON.parse(
    gunzipSync(await readFile("work/columnar-bench/" + name)).toString(),
  );
  if (
    run.rows.length !==
      run.manifest.contracts *
        run.manifest.plans.length *
        run.manifest.repeats ||
    run.rows.some((r: any) => r.error || r.unsupported) ||
    run.manifest.preparedDownloads
  )
    throw Error("Incomplete/incorrect/nonlocal run: " + name);
  runs.push({ name, ...run });
}
if (runs.length !== 6) throw Error("Expected six completed runs");
for (const k of [
  "generation",
  "corpusHash",
  "pairRouterSha256",
  "contractSha256",
  "implementationSha256",
  "sharedCacheMiB",
  "node",
])
  if (new Set(runs.map((r) => r.manifest[k])).size !== 1)
    throw Error("Changed comparison inputs: " + k);
const quantiles = (values: number[]) => {
  values = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    values[Math.max(0, Math.ceil(values.length * p) - 1)];
  return {
    n: values.length,
    min: at(0),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: at(1),
  };
};
const measures: Record<string, (r: any) => number> = {
  wallMs: (r) => r.wallMs,
  cpuMs: (r) => r.localProcessCpuMs,
  scoreBlocksFetched: (r) => r.diagnostics.scoreBlocksFetched,
  scoreBlocksDecoded: (r) => r.diagnostics.scoreBlocksDecoded,
  scorePostingsDecoded: (r) => r.diagnostics.scorePostingsDecoded,
  scoreFetchWaves: (r) => r.diagnostics.scoreFetchWaves,
  scoreIOWaves: (r) => r.diagnostics.scoreIOWaves,
  postings: (r) => r.diagnostics.postings,
  positions: (r) => r.diagnostics.positionIntegers,
  partialRejected: (r) => r.diagnostics.partialScoreRejected,
  lazyWindows: (r) => r.diagnostics.lazyScoreWindows,
  eagerFetchWindows: (r) => r.diagnostics.eagerScoreFetchWindows,
  lazyFetchWindows: (r) =>
    r.diagnostics.lazyScoreWindows +
    r.diagnostics.eagerScoreWindows -
    r.diagnostics.eagerScoreFetchWindows,
  originReads: (r) => r.modeledIO.r2,
  originBytes: (r) => r.modeledIO.r2Bytes,
  sharedReads: (r) => r.modeledIO.sharedGet,
  sharedBytes: (r) => r.modeledIO.sharedGetBytes,
  metadataMs: (r) => r.diagnostics.metadataMs,
  peakActiveBufferBytes: (r) => r.diagnostics.peakActiveBufferBytes,
  retainedPageBytes: (r) => r.diagnostics.retainedPageBytes,
  retainedDecodedBytes: (r) => r.diagnostics.retainedDecodedBytes,
};
const summaries = [];
for (const condition of [
  "memory-reuse",
  "shared-warm-memory-empty",
  "fresh-namespace",
]) {
  const group = runs.filter((r) => r.manifest.condition === condition);
  if (group.length !== 2) throw Error("Missing session");
  const rows = group.flatMap((r) => r.rows);
  for (const key of new Set(
    rows.map((r: any) => JSON.stringify([r.q, r.options])),
  )) {
    const [q, options] = JSON.parse(key),
      matching = rows.filter(
        (r: any) => JSON.stringify([r.q, r.options]) === key,
      ),
      variants = Object.fromEntries(
        ["control-N100-M1000", "auto-N100-M1000"].map((plan) => {
          const rs = matching.filter((r: any) => r.plan === plan);
          return [
            plan,
            {
              n: rs.length,
              ...Object.fromEntries(
                Object.entries(measures).map(([k, f]) => [
                  k,
                  quantiles(rs.map(f)),
                ]),
              ),
              executors: [
                ...new Set(rs.map((r: any) => r.diagnostics.executor)),
              ],
            },
          ];
        }),
      );
    if (
      matching.some((r: any) => r.resultSha256) &&
      (matching.some((r: any) => !r.resultSha256) ||
        new Set(matching.map((r: any) => r.resultSha256)).size !== 1)
    )
      throw Error("Exact complete-response mismatch: " + condition + ":" + q);
    summaries.push({ condition, q, options, kind: matching[0].kind, variants });
  }
}
await mkdir(out, { recursive: true });
const contracts = await readFile(runs[0].manifest.contractFile);
if (
  createHash("sha256").update(contracts).digest("hex") !==
  runs[0].manifest.contractSha256
)
  throw Error("Changed contracts");
await writeFile(out + "/contracts.json.gz", gzipSync(contracts));
for (const r of runs)
  await copyFile("work/columnar-bench/" + r.name, out + "/" + r.name);
await copyFile(
  controlFile ?? "work/maxscore-control-b322b8b/instrumentation.json",
  out + (controlFile ? "/control.json" : "/control-instrumentation.json"),
);
const result = {
  kind: "Local 1M simulated I/O; not live Cloudflare",
  requests: runs.reduce((n, r) => n + r.rows.length, 0),
  manifests: runs.map(({ name, manifest }) => ({ name, manifest })),
  notes: [
    controlFile
      ? "Untouched frozen control: " +
        (await readFile(controlFile, "utf8")).trim()
      : "Control b322b8b: counter-only annotations wrap the original many()/prefetch() calls; matching, decode order, fetch order and scheduling are unchanged.",
    "Score metrics cover numeric window execution and its lookahead, excluding complete-term/document-package alternatives and pre-window selective anchors. Blocks fetched counts unique logical blocks requested, including prefetch; physical range coalescing can transfer extra bytes, reported separately. Decoded blocks/postings count actual work, including repetitions.",
    "Score fetch waves count nonempty score-read or prefetch calls; score I/O waves count those calls that performed shared-cache or origin operations. Neither includes term-tree/position/result stages. These are sequential score phases, not total request GET counts.",
    "Two independently randomized sessions per cache condition, isolated per-version bounded caches, complete responses, no response cache. Bundled roots remain resident; host filesystem cache is not controlled.",
    "CPU is local process CPU; latency has modeled storage delays. Quartiles/ranges are descriptive; sample sizes do not establish P95/P99 or production percentiles.",
  ],
  summaries,
};
await writeFile(out + "/summary.json", JSON.stringify(result, null, 2) + "\n");
await writeFile(out + "/summary.json.gz", gzipSync(JSON.stringify(result)));
for (const s of summaries) {
  const b = s.variants["control-N100-M1000"] as any,
    a = s.variants["auto-N100-M1000"] as any;
  console.log(
    s.condition,
    JSON.stringify(s.q),
    s.options,
    Math.round(b.wallMs.median) + " -> " + Math.round(a.wallMs.median),
    "blocks",
    b.scoreBlocksFetched.median,
    a.scoreBlocksFetched.median,
    "postings",
    b.scorePostingsDecoded.median,
    a.scorePostingsDecoded.median,
    "IO waves",
    b.scoreIOWaves.median,
    a.scoreIOWaves.median,
  );
}
