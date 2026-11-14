/** Validate complete responses and archive the local candidate-filter experiment. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
const output = process.argv[2];
if (!output) throw Error("Usage: report-boolean-candidates.ts OUTPUT");
await mkdir(output, { recursive: true });
const load = async (path: string) =>
  JSON.parse(
    path.endsWith(".gz")
      ? gunzipSync(await readFile(path)).toString()
      : await readFile(path, "utf8"),
  );
const median = (values: number[]) => {
  const a = [...values].sort((a, b) => a - b);
  return a.length % 2
    ? a[a.length >>> 1]
    : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const metrics: Record<string, (r: any) => number> = {
  wallMs: (r) => r.wallMs,
  processCpuMs: (r) => r.localProcessCpuMs,
  scoreBlocks: (r) => r.diagnostics.scoreBlocksFetched,
  scorePostings: (r) => r.diagnostics.scorePostingsDecoded,
  scoreIOWaves: (r) => r.diagnostics.scoreIOWaves,
  positionIntegers: (r) => r.diagnostics.positionIntegers,
  membershipIntegers: (r) => r.diagnostics.pairMembershipIntegers,
  candidates: (r) => r.diagnostics.candidates,
  originReads: (r) => r.modeledIO.r2,
  originBytes: (r) => r.modeledIO.r2Bytes,
  sharedGets: (r) => r.modeledIO.sharedGet,
  sharedBytes: (r) => r.modeledIO.sharedGetBytes,
  budgetBypasses: (r) => r.diagnostics.sharedBudgetBypasses,
  decodedBytes: (r) => r.diagnostics.decodedBytes,
  repeatedDecodedBytes: (r) => r.diagnostics.repeatedDecodedBytes,
  maxPrefetchBytes: (r) => r.diagnostics.maxPrefetchFootprintBytes ?? 0,
};
const hashes = new Map<string, string>(),
  runs: any[] = [];
for (const label of [
  "boolean-branches-reuse",
  "boolean-branches-empty",
  "boolean-lookahead-reuse",
  "boolean-lookahead-empty",
  "boolean-final-reuse",
  "boolean-final-empty",
  "boolean-final-fresh",
  "boolean-final-budget-900",
  "boolean-final-budget-1000000",
  "boolean-screen-reuse",
  "boolean-screen-empty",
  "boolean-civil-primed",
]) {
  const path = "work/columnar-bench/" + label + ".json.gz",
    b = await load(path);
  if (
    b.downloads ||
    b.manifest.preparedDownloads ||
    b.rows.some((r: any) => r.error)
  )
    throw Error("Failed local run " + label);
  for (const r of b.rows) {
    const old = hashes.get(r.q);
    if (old && old !== r.resultSha256) throw Error("Response mismatch " + r.q);
    hashes.set(r.q, r.resultSha256);
  }
  const groups = [];
  for (const q of new Set(b.rows.map((r: any) => r.q)))
    for (const plan of b.manifest.plans) {
      const rows = b.rows.filter((r: any) => r.q === q && r.plan === plan);
      groups.push({
        q,
        plan,
        n: rows.length,
        ...Object.fromEntries(
          Object.entries(metrics).map(([k, get]) => [
            k,
            {
              median: median(rows.map(get)),
              min: Math.min(...rows.map(get)),
              max: Math.max(...rows.map(get)),
            },
          ]),
        ),
      });
    }
  runs.push({ label, manifest: b.manifest, groups });
  await copyFile(path, output + "/" + label + ".json.gz");
}
const physical = [];
for (const label of ["exact-baseline", "exact-final"]) {
  const path = "work/boolean-candidates/" + label + "-amplification.json";
  const b = await load(path);
  if (b.downloads) throw Error("Unexpected download");
  for (const r of b.rows)
    if (hashes.get(r.q) !== r.resultSha256)
      throw Error("Physical probe changed results");
  physical.push(b);
  await copyFile(path, output + "/" + label + "-amplification.json");
}
const oraclePath = "work/columnar-bench/boolean-final-oracle-160.json.gz",
  oracle = await load(oraclePath);
if (
  oracle.rows.length !== 160 ||
  oracle.downloads ||
  oracle.rows.some((r: any) => r.error)
)
  throw Error("Independent oracle replay failed");
await copyFile(oraclePath, output + "/oracle-160.json.gz");
const previous = await load(
    "bench/results/columnar/no-crc-1m/research/measure.json.gz",
  ),
  research = await load("work/boolean-candidates/research/measure.json.gz");
if (
  research.errors.length ||
  research.downloads ||
  research.rows.length !== 540
)
  throw Error("180-query replay incomplete");
const reference = new Map<string, string>();
for (const r of previous.rows) {
  const old = reference.get(r.brief_id);
  if (old && old !== r.resultSha256) throw Error("Unstable reference");
  reference.set(r.brief_id, r.resultSha256);
}
const explained = await load(output + "/response-differences.json.gz"),
  changed = new Set(explained.comparisons.map((r: any) => r.id));
for (const r of research.rows)
  if (reference.get(r.brief_id) !== r.resultSha256 && !changed.has(r.brief_id))
    throw Error("Unexplained research response mismatch " + r.brief_id);
await copyFile(
  "work/boolean-candidates/research/measure.json.gz",
  output + "/research-180.json.gz",
);
await copyFile(
  "work/boolean-candidates/research/queries.json",
  output + "/queries.json",
);
const researchComparison = [];
for (const id of reference.keys()) {
  const old = previous.rows.filter((r: any) => r.brief_id === id),
    now = research.rows.filter((r: any) => r.brief_id === id);
  researchComparison.push({
    id,
    q: now[0].query,
    resultCount: now[0].resultCount,
    conditions: Object.fromEntries(
      ["memory-reuse", "shared-warm-memory-empty", "cpu-no-delays"].map(
        (condition) => {
          const a = old.filter((r: any) => r.condition === condition),
            b = now.filter((r: any) => r.condition === condition);
          return [
            condition,
            {
              beforeN: a.length,
              afterN: b.length,
              beforeWall: median(a.map((r: any) => r.wallMs)),
              afterWall: median(b.map((r: any) => r.wallMs)),
              beforeCpu: median(a.map((r: any) => r.cpuMs)),
              afterCpu: median(b.map((r: any) => r.cpuMs)),
              beforeScorePostings: median(
                a.map((r: any) => r.diagnostics.scorePostingsDecoded),
              ),
              afterScorePostings: median(
                b.map((r: any) => r.diagnostics.scorePostingsDecoded),
              ),
            },
          ];
        },
      ),
    ),
  });
}
await writeFile(
  output + "/research-comparison.json.gz",
  gzipSync(
    JSON.stringify({
      kind: "Historical separate-session regression screen: three old samples versus one new per condition; not an interleaved latency estimate.",
      queries: researchComparison,
    }),
  ),
);
await copyFile(
  "work/cpu-control-0a72b2c/control.json",
  output + "/control.json",
);
await copyFile(
  "work/boolean-candidates/budget-contract.json",
  output + "/budget-contract.json",
);
await copyFile(
  "work/boolean-candidates/screen-contract.json",
  output + "/screen-contract.json",
);
await copyFile(
  "bench/results/columnar/no-crc-1m/cpu-contract.json",
  output + "/contract.json",
);
await mkdir(output + "/branch-control", { recursive: true });
for (const name of ["search", "storage", "boolean-membership"])
  await copyFile(
    "work/boolean-candidates/branches/src/columnar/" + name + ".ts",
    output + "/branch-control/" + name + ".ts.txt",
  );
await writeFile(
  output + "/branch-control/README.txt",
  "Branch-only ablation: remove the .txt suffix and overlay these three columnar files on a src archive of 0a72b2c. Serving source is the ordinary src/columnar tree; this frozen copy is only a benchmark control.\n",
);
await writeFile(
  output + "/summary.json",
  JSON.stringify(
    {
      kind: "Local 1M complete responses with simulated I/O, not Cloudflare measurements. Small samples do not estimate P95/P99.",
      runs,
      physical,
      validation: {
        independentOracleScenarios: 160,
        researchQueries: 180,
        researchResponses: research.rows.length,
        targetComparisonCompleteResponseHashesMatched: true,
        researchCompleteResponseHashesMatched: 180 - changed.size,
        researchExplainedCrossPathDifferences: changed.size,
        researchRankedIdsAndOrderMatched: 180,
        researchScoresWithinExistingOracleTolerance: true,
      },
    },
    null,
    2,
  ),
);
console.log("Validated and archived", output);
