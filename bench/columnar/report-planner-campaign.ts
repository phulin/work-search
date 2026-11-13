import {
  readFile,
  readdir,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const [prefix, out] = process.argv.slice(2);
if (!prefix || !out)
  throw Error("Usage: report-planner-campaign.ts PREFIX OUTPUT_DIR");
const names = (await readdir("work/columnar-bench"))
    .filter((n) => n.startsWith(prefix + "-") && /-s\d+\.json\.gz$/.test(n))
    .sort(),
  runs = [];
for (const name of names) {
  const raw = await readFile("work/columnar-bench/" + name),
    run = JSON.parse(gunzipSync(raw).toString());
  if (
    run.rows.length !==
      run.manifest.contracts *
        run.manifest.plans.length *
        run.manifest.repeats ||
    run.rows.some((r: any) => r.error || r.unsupported)
  )
    throw Error("Incomplete/incorrect run: " + name);
  runs.push({ name, raw, ...run });
}
if (runs.length !== 6)
  throw Error("Expected two sessions for each of three cache conditions");
for (const key of [
  "generation",
  "corpusHash",
  "pairRouterSha256",
  "contractSha256",
  "implementationSha256",
  "sharedCacheMiB",
  "node",
])
  if (new Set(runs.map((r) => r.manifest[key])).size !== 1)
    throw Error("Comparison inputs changed: " + key);
const percentile = (values: number[], p: number) => {
  values = [...values].sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * p) - 1)];
};
function stats(rows: any[], get: (r: any) => number | undefined) {
  const values = rows
    .map(get)
    .filter((n): n is number => typeof n === "number");
  return values.length
    ? {
        n: values.length,
        min: percentile(values, 0),
        p25: percentile(values, 0.25),
        median: percentile(values, 0.5),
        p75: percentile(values, 0.75),
        max: percentile(values, 1),
      }
    : null;
}
const summaries = [];
for (const condition of [
  "memory-reuse",
  "shared-warm-memory-empty",
  "fresh-namespace",
]) {
  const matching = runs.filter((r) => r.manifest.condition === condition),
    rows = matching.flatMap((r) =>
      r.rows.map((row: any) => ({ ...row, session: r.name })),
    );
  if (matching.length !== 2) throw Error("Missing repeated condition");
  const keys = [
    ...new Set(rows.map((r: any) => JSON.stringify([r.q, r.options]))),
  ];
  for (const key of keys) {
    const [q, options] = JSON.parse(key),
      group = rows.filter((r: any) => JSON.stringify([r.q, r.options]) === key),
      variants = Object.fromEntries(
        ["control-N100-M1000", "auto-N100-M1000"].map((plan) => {
          const data = group.filter((r: any) => r.plan === plan);
          return [
            plan,
            {
              n: data.length,
              wallMs: stats(data, (r) => r.wallMs),
              cpuMs: stats(data, (r) => r.localProcessCpuMs),
              pairMembershipIntegers: stats(
                data,
                (r) => r.diagnostics.pairMembershipIntegers,
              ),
              commonPresenceIntegers: plan.startsWith("control-")
                ? null
                : stats(data, (r) => r.diagnostics.commonPresenceIntegers),
              positionIntegers: stats(
                data,
                (r) => r.diagnostics.positionIntegers,
              ),
              postings: stats(data, (r) => r.diagnostics.postings),
              originReads: stats(data, (r) => r.modeledIO.r2),
              originBytes: stats(data, (r) => r.modeledIO.r2Bytes),
              sharedReads: stats(data, (r) => r.modeledIO.sharedGet),
              sharedBytes: stats(data, (r) => r.modeledIO.sharedGetBytes),
              memoryHits: stats(data, (r) => r.diagnostics.memoryHits),
              pairPackets: stats(
                data,
                (r) => r.diagnostics.pairDirectoryRanges,
              ),
              executors: [
                ...new Set(data.map((r: any) => r.diagnostics.executor)),
              ],
            },
          ];
        }),
      );
    const before = variants["control-N100-M1000"],
      after = variants["auto-N100-M1000"];
    summaries.push({
      condition,
      q,
      options,
      kind: group[0].kind,
      variants,
      wallChange: after.wallMs!.median / before.wallMs!.median - 1,
      cpuChange: after.cpuMs!.median / before.cpuMs!.median - 1,
    });
  }
}
await mkdir(out, { recursive: true });
const contracts = await readFile(runs[0].manifest.contractFile);
if (
  createHash("sha256").update(contracts).digest("hex") !==
  runs[0].manifest.contractSha256
)
  throw Error("Query contract changed");
await writeFile(out + "/contracts.json.gz", gzipSync(contracts));
for (const run of runs)
  await copyFile("work/columnar-bench/" + run.name, out + "/" + run.name);
const result = {
  kind: "Local 1M simulated-I/O comparison; not live Cloudflare",
  controlRevision: "2d77fc05ea3a279e83e0a45df6dd3c9fdac7dee6",
  attempts: runs.reduce((n, r) => n + r.rows.length, 0),
  manifests: runs.map(({ name, manifest }) => ({ name, manifest })),
  notes: [
    "N=100/M=1000 for both versions; immutable pair/context bytes are unchanged.",
    "Each condition has two independent sessions and ten samples per query/version; quartiles/ranges are descriptive, not P99 or production confidence intervals.",
    "Warm reuse; reset page/decoded/term caches with warm shared pages; and reset those caches with a fresh shared-cache namespace. Bundled roots remain resident. Host filesystem caches are not controlled.",
    "The shared cache is bounded at 1 GiB; warm conditions retain the evolving workload cache and may incur origin reads after eviction.",
    "Pair-membership integer decoding is comparable for both versions. The old engine did not instrument common-presence decoding; its missing metric is null, not zero.",
    "R2 and shared-read counts/bytes come from the same simulated storage boundary in both versions. Response caching is disabled; metadata, snippets and JSON serialization are included.",
  ],
  summaries,
};
await writeFile(out + "/summary.json", JSON.stringify(result, null, 2));
await writeFile(out + "/summary.json.gz", gzipSync(JSON.stringify(result)));
for (const condition of [
  "memory-reuse",
  "shared-warm-memory-empty",
  "fresh-namespace",
]) {
  console.log(condition);
  for (const s of summaries.filter((s) => s.condition === condition))
    console.log(
      JSON.stringify({
        q: s.q,
        options: s.options,
        before: Math.round(s.variants["control-N100-M1000"].wallMs!.median),
        after: Math.round(s.variants["auto-N100-M1000"].wallMs!.median),
        change: Math.round(s.wallChange * 100),
      }),
    );
}
