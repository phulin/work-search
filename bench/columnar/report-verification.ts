import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const files = process.argv.slice(2);
if (!files.length)
  throw Error("Usage: report-verification.ts RESULTS.json.gz...");
const median = (a: number[]) => {
    a.sort((a, b) => a - b);
    return a[Math.floor(a.length / 2)] ?? 0;
  },
  fields = [
    "wallMs",
    "localProcessCpuMs",
    "requests",
    "bytes",
    "scorePostingsDecoded",
    "positionIntegers",
    "forwardIntegers",
    "pairPositionBytes",
    "pairPositionChunks",
    "candidatePackageBytes",
    "documentVerificationBytes",
    "documentVerificationRanges",
    "documentPresentationBytes",
    "scoreIOWaves",
    "positionIOWaves",
    "packageIOWaves",
    "stages",
    "packagePipelineLoads",
    "packagePipelineWaits",
    "peakPackagePipelinePending",
    "resultRequests",
    "resultBytes",
    "peakActiveBufferBytes",
    "decodedBytes",
    "retainedPageBytes",
    "retainedDecodedBytes",
  ];
const reports = [];
for (const file of files) {
  const data = JSON.parse(gunzipSync(await readFile(file)).toString()),
    groups = new Map<string, any[]>();
  for (const row of data.rows) {
    if (row.error || row.unsupported)
      throw Error("Incomplete comparison: " + file);
    const key = JSON.stringify([row.q, row.options]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const comparisons = [];
  for (const [key, rows] of groups) {
    const sets = [
      rows.filter((r) => r.plan.startsWith("control")),
      rows.filter((r) => r.plan.startsWith("auto")),
    ];
    if (sets.some((rs) => !rs.length)) throw Error("Missing comparison side");
    if (new Set(rows.map((r) => r.semanticSha256)).size !== 1)
      throw Error("Rendering, total or ordering mismatch: " + key);
    const summaries = sets.map((rs) =>
      Object.fromEntries(
        fields.map((f) => [
          f,
          median(rs.map((r) => r[f] ?? r.diagnostics?.[f] ?? 0)),
        ]),
      ),
    );
    comparisons.push({
      q: rows[0].q,
      kind: rows[0].kind,
      options: rows[0].options,
      n: sets.map((rs) => rs.length),
      control: summaries[0],
      candidate: summaries[1],
    });
  }
  reports.push({
    file,
    manifest: data.manifest,
    responses: data.rows.length,
    comparisons,
  });
}
await mkdir("work/verification-results", { recursive: true });
await writeFile(
  "work/verification-results/summary.json",
  JSON.stringify(reports, null, 2),
);
for (const report of reports) {
  console.log(
    report.file,
    report.manifest.condition,
    report.responses,
    "responses",
  );
  for (const r of report.comparisons.filter((r) =>
    /absence|burden of proving|mandate rule|requests for admission|Second Amendment|summary judgment.*arbitration|rules OR of/.test(
      r.q,
    ),
  ))
    console.log(
      r.q,
      "latency",
      Math.round(r.control.wallMs),
      "→",
      Math.round(r.candidate.wallMs),
      "CPU",
      Math.round(r.control.localProcessCpuMs),
      "→",
      Math.round(r.candidate.localProcessCpuMs),
      "MiB",
      (r.control.bytes / 1048576).toFixed(2),
      "→",
      (r.candidate.bytes / 1048576).toFixed(2),
    );
  console.log(
    "Regressions",
    report.comparisons
      .filter(
        (r) =>
          r.candidate.wallMs > r.control.wallMs + 20 &&
          r.candidate.wallMs > r.control.wallMs * 1.15,
      )
      .sort(
        (a, b) =>
          b.candidate.wallMs -
          b.control.wallMs -
          (a.candidate.wallMs - a.control.wallMs),
      )
      .slice(0, 8)
      .map((r) => ({
        q: r.q,
        before: Math.round(r.control.wallMs),
        after: Math.round(r.candidate.wallMs),
      })),
  );
}
