import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const labels = process.argv.slice(2),
  out = "bench/results/columnar";
if (!labels.length)
  throw Error(
    "Usage: yarn node --import tsx bench/columnar/packet-report.ts LABEL...",
  );
await mkdir(out, { recursive: true });
function distribution(values: number[]) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => a[Math.max(0, Math.ceil(a.length * p) - 1)];
  return { n: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}
for (const label of labels) {
  const file = `work/columnar-bench/${label}.json.gz`,
    data = JSON.parse(gunzipSync(await readFile(file)).toString()),
    tail = await readFile(`work/columnar-bench/${label}-cpu.json.gz`).then(
      (b) => JSON.parse(gunzipSync(b).toString()),
      () => ({ rows: [] }),
    ),
    cpu = new Map(
      tail.rows.map((r: any) => [r.telemetry?.requestId ?? r.requestId, r]),
    ),
    rows = data.rows.filter((r: any) => !r.warmup),
    plans = [...new Set<string>(rows.map((r: any) => r.plan))],
    supported = (a: any[]) =>
      a.filter((r) => !r.error && !r.unsupported && r.status === 200),
    stats = (a: any[]) => ({
      attempts: a.length,
      unsupported: a.filter((r) => r.unsupported).length,
      errors: a.filter((r) => r.error).length,
      completeMs: distribution(supported(a).map((r) => r.ms)),
      workerMs: distribution(supported(a).map((r) => r.telemetry?.wallMs)),
      cpuMs: distribution(
        supported(a).map((r) => (cpu.get(r.requestId) as any)?.cpuMs),
      ),
      candidates: distribution(
        supported(a).map((r) => r.diagnostics.candidates),
      ),
      originGets: distribution(supported(a).map((r) => r.diagnostics.requests)),
      sharedGets: distribution(
        supported(a).map((r) => r.diagnostics.sharedGets),
      ),
      metadataMs: distribution(
        supported(a).map((r) => r.diagnostics.metadataMs),
      ),
      resultOriginGets: distribution(
        supported(a).map((r) => r.diagnostics.resultRequests),
      ),
      resultSharedGets: distribution(
        supported(a).map((r) => r.diagnostics.resultSharedGets),
      ),
      coalescedExtraBytes: distribution(
        supported(a).map((r) => r.diagnostics.coalescedExtraBytes),
      ),
    });
  const groups = new Map<string, any[]>();
  for (const row of supported(rows)) {
    const key = JSON.stringify([
      row.repeat,
      row.options === undefined ? undefined : row.kind,
      row.q,
      row.options,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  // Older pilots omitted options. Reject ambiguous duplicate groups rather than
  // accidentally pairing different fields, boosts, or page contracts.
  const paired = [...groups.values()].filter((a) =>
    plans.every((p) => a.filter((r) => r.plan === p).length === 1),
  );
  const buckets = (bounds: number[], value: (group: any[]) => number) =>
    bounds.map((upper, i) => {
      const lower = i ? bounds[i - 1] : 0,
        selected = paired.filter((g) => value(g) >= lower && value(g) < upper);
      return {
        lower,
        upper: upper === Infinity ? "unbounded" : upper,
        pairs: selected.length,
        plans: Object.fromEntries(
          plans.map((p) => [
            p,
            stats(selected.map((g) => g.find((r) => r.plan === p))),
          ]),
        ),
        firstPlanWins: selected.filter(
          (g) =>
            g.find((r) => r.plan === plans[0]).ms <
            g.find((r) => r.plan === plans[1]).ms,
        ).length,
      };
    });
  const report = {
    manifest: data.manifest,
    caveats: [
      "Complete-response timings include metadata and snippets. Unsupported strategies are not correctness failures.",
      "Pilot percentiles are conditional on this scenario mix, not production traffic. Small samples do not establish P99 or a universal crossover.",
      "Paired groups exclude missing/unsupported strategies and ambiguous duplicates. Transfer sizes describe packed streams, not general-purpose compression.",
    ],
    requests: rows.length,
    pairedComparisons: paired.length,
    pairedPlans: Object.fromEntries(
      plans.map((p) => [
        p,
        stats(paired.map((g) => g.find((r) => r.plan === p))),
      ]),
    ),
    plans: Object.fromEntries(
      plans.map((p) => [p, stats(rows.filter((r: any) => r.plan === p))]),
    ),
    classes: [...new Set(rows.map((r: any) => r.kind))].map((kind) => ({
      kind,
      plans: Object.fromEntries(
        plans.map((p) => [
          p,
          stats(rows.filter((r: any) => r.plan === p && r.kind === kind)),
        ]),
      ),
    })),
    byCandidates: buckets(
      [1, 2, 6, 17, 65, 257, 513, Infinity],
      (g) =>
        g.find((r) => r.plan === "documents")?.diagnostics.candidates ??
        g[0].diagnostics.candidates,
    ),
    byCompleteTermBytes: buckets(
      [1024, 16384, 65536, 262144, 1048576, 4194304, 8388609, Infinity],
      (g) => {
        const d = g.find((r) => r.plan === "complete-terms")?.diagnostics.plan;
        return d ? d.frequencyBytes + d.positionBytes : NaN;
      },
    ),
  };
  await copyFile(file, `${out}/${label}.json.gz`);
  if (tail.rows.length)
    await copyFile(
      `work/columnar-bench/${label}-cpu.json.gz`,
      `${out}/${label}-cpu.json.gz`,
    );
  await writeFile(
    `${out}/${label}-summary.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    label,
    JSON.stringify({
      requests: report.requests,
      pairs: paired.length,
      plans: report.plans,
    }),
  );
}
