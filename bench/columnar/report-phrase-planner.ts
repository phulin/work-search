/** Summarize the local planner comparison, retaining every query and raw run. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const output = "bench/results/columnar/phrase-planner-1m";
await mkdir(output, { recursive: true });
const metrics = [
  "requests",
  "bytes",
  "sharedGets",
  "sharedPuts",
  "sharedBudgetBypasses",
  "scoreBlocksFetched",
  "scorePostingsDecoded",
  "scoreIOWaves",
  "positionIOWaves",
  "positionIntegers",
  "wordPositionIntegers",
  "exactPhraseReads",
  "exactPhraseBytes",
  "exactPhraseOccurrences",
  "exactPhraseDiscoveryReads",
  "exactPhraseDiscoveryBytes",
  "exactPhraseDiscoveryWaves",
  "pairMembershipIntegers",
  "pairMembershipDecodedBytes",
  "peakExactPhraseBufferBytes",
  "peakExactPhraseWindows",
  "prefetchWindows",
  "maxPrefetchFootprintBytes",
  "peakActiveBufferBytes",
  "documentVerificationBytes",
  "documentPresentationBytes",
  "metadataMs",
  "decodedBytes",
  "repeatedDecodedBytes",
  "inflatedBytes",
  "repeatedInflatedBytes",
];
const distribution = (xs: number[]) => {
  const a = xs.filter(Number.isFinite).sort((a, b) => a - b),
    n = a.length;
  return n
    ? {
        n,
        min: a[0],
        median: n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2,
        max: a[n - 1],
      }
    : { n: 0, min: null, median: null, max: null };
};
const quantiles = (xs: number[]) => {
  const a = xs.sort((a, b) => a - b);
  return Object.fromEntries(
    [50, 95, 99].map((p) => ["p" + p, a[Math.ceil((p * a.length) / 100) - 1]]),
  );
};
const all = [],
  requested = process.argv.slice(2);
for (const name of requested.length
  ? requested
  : [
      "focused-empty",
      "focused-shared",
      "focused-reuse",
      "wide-shared",
      "wide-empty",
      "independent",
    ]) {
  const file = "phrase-planner-" + name + ".json.gz",
    run = JSON.parse(
      gunzipSync(await readFile("work/columnar-bench/" + file)).toString(),
    ),
    expected =
      run.manifest.contracts * run.manifest.plans.length * run.manifest.repeats;
  if (
    all.length &&
    all[0].manifest.implementationSha256 !== run.manifest.implementationSha256
  )
    throw Error(
      "Serving implementation changed between finalist runs: " + name,
    );
  if (
    run.rows.length !== expected ||
    run.rows.some((r: any) => r.error || r.unsupported)
  )
    throw Error("Incomplete/failed run: " + name);
  if (
    name.startsWith("wide-") &&
    run.rows.some((r: any) => r.options?.exactTotal !== false)
  )
    throw Error(
      "The 200-query performance comparison must have exact totals off",
    );
  const groups = new Map<string, any[]>();
  for (const r of run.rows) {
    const key = JSON.stringify([r.q, r.options]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const queries = [...groups].map(([key, rows]) => {
    if (new Set(rows.map((r) => r.semanticSha256)).size !== 1)
      throw Error("Response mismatch: " + key);
    const summarize = (plan: string) => {
      const rs = rows.filter((r) => r.plan.startsWith(plan));
      if (!rs.length) return undefined;
      return {
        n: rs.length,
        wallMs: distribution(rs.map((r) => r.wallMs)),
        cpuMs: distribution(rs.map((r) => r.localProcessCpuMs)),
        counters: Object.fromEntries(
          metrics.map((m) => [
            m,
            distribution(rs.map((r) => r.diagnostics[m])),
          ]),
        ),
        executors: [...new Set(rs.map((r) => r.diagnostics.executor))],
        phrasePlans: rs[0].diagnostics.exactPhrasePlans,
      };
    };
    const [q, options] = JSON.parse(key),
      before = summarize("control"),
      after = summarize("auto")!;
    return {
      q,
      kind: rows[0].kind,
      options,
      before,
      after,
      latencyDeltaMs: before
        ? after.wallMs.median! - before.wallMs.median!
        : null,
    };
  });
  const compared = queries.filter((q) => q.before),
    regressions = compared.filter(
      (q) =>
        q.latencyDeltaMs! > 10 &&
        q.after.wallMs.median! > q.before!.wallMs.median! * 1.1,
    ),
    wins = compared.filter(
      (q) =>
        q.latencyDeltaMs! < -10 &&
        q.after.wallMs.median! < q.before!.wallMs.median! * 0.9,
    );
  const summary = {
    name,
    manifest: run.manifest,
    requests: run.rows.length,
    correct: true,
    exactTotalSettings: {
      off: queries.filter((q) => !q.options.exactTotal).length,
      on: queries.filter((q) => q.options.exactTotal).length,
    },
    measuredRequestPercentiles: compared.length
      ? {
          note: "Empirical percentiles of this equally represented simulated workload; not production traffic.",
          before: quantiles(
            run.rows
              .filter((r: any) => r.plan.startsWith("control"))
              .map((r: any) => r.wallMs),
          ),
          after: quantiles(
            run.rows
              .filter((r: any) => r.plan.startsWith("auto"))
              .map((r: any) => r.wallMs),
          ),
        }
      : undefined,
    scenarioMedianPercentiles: compared.length
      ? {
          note: "Percentiles of query/options medians; not production traffic or request-tail estimates.",
          before: quantiles(compared.map((q) => q.before!.wallMs.median!)),
          after: quantiles(compared.map((q) => q.after.wallMs.median!)),
        }
      : undefined,
    classes: Object.fromEntries(
      [...new Set(compared.map((q) => q.kind))].map((kind) => {
        const qs = compared.filter((q) => q.kind === kind);
        return [
          kind,
          {
            queries: qs.length,
            before: quantiles(qs.map((q) => q.before!.wallMs.median!)),
            after: quantiles(qs.map((q) => q.after.wallMs.median!)),
          },
        ];
      }),
    ),
    materialWins: wins.length,
    materialRegressions: regressions.map((q) => ({
      q: q.q,
      options: q.options,
      beforeMs: q.before!.wallMs.median,
      afterMs: q.after.wallMs.median,
    })),
    queries,
  };
  all.push(summary);
  await copyFile("work/columnar-bench/" + file, output + "/" + file);
  await writeFile(
    output + "/" + name + ".json",
    JSON.stringify(summary, null, 2) + "\n",
  );
  const header = [
      "query",
      "options",
      "n_before",
      "n_after",
      "ms_before",
      "ms_after",
      "cpu_before",
      "cpu_after",
      ...metrics.flatMap((m) => [m + "_before", m + "_after"]),
    ],
    csv = [
      header,
      ...queries.map((q) => [
        q.q,
        JSON.stringify(q.options),
        q.before?.n,
        q.after.n,
        q.before?.wallMs.median,
        q.after.wallMs.median,
        q.before?.cpuMs.median,
        q.after.cpuMs.median,
        ...metrics.flatMap((m) => [
          q.before?.counters[m]?.median,
          q.after.counters[m]?.median,
        ]),
      ]),
    ];
  await writeFile(
    output + "/" + name + ".csv",
    csv
      .map((row) => row.map((v) => JSON.stringify(String(v ?? ""))).join(","))
      .join("\n") + "\n",
  );
  console.log(
    name,
    summary.requests,
    "correct responses",
    JSON.stringify(summary.scenarioMedianPercentiles),
    "wins",
    wins.length,
    "regressions",
    JSON.stringify(summary.materialRegressions),
  );
}
if (requested.length) process.exit(0);
const profile = JSON.parse(
  await readFile("work/phrase-planner-tail-profiles/summary.json", "utf8"),
);
for (const [key, file] of [
  ["exactPhraseSha256", "exact-phrase.ts"],
  ["searchSha256", "search.ts"],
])
  if (
    profile[key] !==
    createHash("sha256")
      .update(await readFile("src/columnar/" + file))
      .digest("hex")
  )
    throw Error("Stale cold profile: " + file);
if (profile.cacheCondition !== "fresh-namespace" || profile.rows.length !== 20)
  throw Error("Missing cold tail profiles");
for (const name of [
  "phrase-planner-tests",
  "phrase-planner-final-check",
  "phrase-planner-final-prettier",
])
  await writeFile(
    output + "/" + name + ".log.gz",
    gzipSync(await readFile("work/" + name + ".log")),
  );
await writeFile(
  output + "/provenance.json",
  JSON.stringify(
    {
      kind: "Local 1M simulated comparisons only; no deployments or Cloudflare activity",
      controlRevision: "4850a4a1699ec93728b25c76ed69bb463e455ac3",
      index: "work/complete-context-v2-1m",
      formatChanged: false,
      contextChanged: false,
      presentationChanged: false,
      requests: all.reduce((n, r) => n + r.requests, 0),
      runs: all.map(
        ({
          name,
          manifest,
          requests,
          scenarioMedianPercentiles,
          measuredRequestPercentiles,
          exactTotalSettings,
          materialWins,
          materialRegressions,
        }) => ({
          name,
          manifest,
          requests,
          scenarioMedianPercentiles,
          measuredRequestPercentiles,
          exactTotalSettings,
          materialWins,
          materialRegressions,
        }),
      ),
      notes: [
        "Randomized/interleaved with independent per-scenario/plan/repeat caches; primePasses is authoritative (the legacy cacheIsolation label says one pass even when primePasses=3).",
        "Exact IDs/order, metadata, snippets and totals agree; oracle scores use relative tolerance 1e-11.",
        "CPU and sampled allocation profiles are local Node attribution, not native Worker measurements.",
        "Active-buffer accounting is an estimate; it does not establish retained or peak process memory.",
        "Candidate peakActiveBufferBytes additionally accounts for retained phrase evidence; compare peakExactPhraseBufferBytes separately instead of interpreting accounting differences as native memory changes.",
      ],
    },
    null,
    2,
  ) + "\n",
);
