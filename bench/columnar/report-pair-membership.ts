import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const [file, out] = process.argv.slice(2);
if (!file || !out)
  throw Error("Usage: report-pair-membership.ts RESULTS.json.gz SUMMARY.json");
const { manifest, rows } = JSON.parse(
  gunzipSync(await readFile(file)).toString(),
);
const quantile = (values: number[], p: number) => {
  values = [...values].sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * p) - 1)];
};
const summarize = (data: any[]) => {
  const success = data.filter((r) => !r.error && !r.unsupported),
    stats = (key: (r: any) => number) => {
      const values = success.map(key);
      return {
        min: quantile(values, 0),
        median: quantile(values, 0.5),
        max: quantile(values, 1),
      };
    };
  return {
    n: success.length,
    errors: data.filter((r) => r.error).length,
    unsupported: data.filter((r) => r.unsupported).length,
    wallMs: stats((r) => r.wallMs),
    localProcessCpuMs: stats((r) => r.localProcessCpuMs),
    postings: stats((r) => r.diagnostics?.postings ?? 0),
    positions: stats((r) => r.diagnostics?.positionIntegers ?? 0),
    membershipIntegers: stats(
      (r) => r.diagnostics?.pairMembershipIntegers ?? 0,
    ),
    r2Requests: stats((r) => r.modeledIO.r2),
    sharedGets: stats((r) => r.modeledIO.sharedGet),
    originBytes: stats((r) => r.diagnostics?.bytes ?? 0),
    metadataMs: stats((r) => r.diagnostics?.metadataMs ?? 0),
    candidates: stats((r) => r.diagnostics?.candidates ?? 0),
    executors: [...new Set(success.map((r) => r.diagnostics?.executor))],
  };
};
const contracts = [
  ...new Set(rows.map((r: any) => JSON.stringify([r.q, r.kind, r.options]))),
];
const queries = contracts.map((key: any) => {
  const [q, kind, options] = JSON.parse(key),
    matching = rows.filter(
      (r: any) => JSON.stringify([r.q, r.kind, r.options]) === key,
    ),
    plans = Object.fromEntries(
      manifest.plans.map((plan: string) => [
        plan,
        summarize(matching.filter((r: any) => r.plan === plan)),
      ]),
    );
  return { q, kind, options, plans };
});
const kinds = [...new Set(rows.map((r: any) => r.kind))];
const classes = kinds.map((kind) => ({
  kind,
  plans: Object.fromEntries(
    manifest.plans.map((plan: string) => [
      plan,
      summarize(rows.filter((r: any) => r.plan === plan && r.kind === kind)),
    ]),
  ),
}));
const result = {
  manifest,
  notes: [
    "Local modeled-I/O complete engine responses, not live Worker or client HTTP latency.",
    "Min/median/max are descriptive; this pilot does not estimate P99 or establish production percentiles.",
    "Each contract has equal repeats; workload classes remain separate.",
    "Untimed correctness/JIT/cache warmup has artificial delays disabled.",
  ],
  attempts: rows.length,
  byPlan: Object.fromEntries(
    manifest.plans.map((plan: string) => [
      plan,
      {
        n: rows.filter(
          (r: any) => r.plan === plan && !r.error && !r.unsupported,
        ).length,
        errors: rows.filter((r: any) => r.plan === plan && r.error).length,
        unsupported: rows.filter((r: any) => r.plan === plan && r.unsupported)
          .length,
      },
    ]),
  ),
  queries,
  classes,
};
await writeFile(out, JSON.stringify(result, null, 2));
console.log(result.byPlan);
for (const query of queries)
  console.log(
    query.q,
    JSON.stringify(query.options),
    Object.fromEntries(
      Object.entries(query.plans).map(([plan, s]: [string, any]) => [
        plan,
        Math.round(s.wallMs.median),
      ]),
    ),
  );
