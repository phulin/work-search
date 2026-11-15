import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
const input =
    process.argv[2] ?? "work/columnar-bench/verification-gets-200.json.gz",
  out = process.argv[3] ?? "bench/results/columnar/verification-gets-1m",
  data = JSON.parse(gunzipSync(await readFile(input)).toString());
const quantile = (values: number[], q: number) => {
  const xs = [...values].sort((a, b) => a - b);
  return xs[Math.max(0, Math.ceil(q * xs.length) - 1)];
};
const groups = new Map<string, any[]>();
for (const r of data.rows) {
  const rows = groups.get(r.q) ?? [];
  rows.push(r);
  groups.set(r.q, rows);
}
const queries = [...groups].map(([q, rows]) => {
  const summarize = (prefix: string) => {
    const xs = rows.filter((r) => r.plan.startsWith(prefix));
    if (!xs.length) throw Error("Missing comparison engine");
    const median = (f: (r: any) => number) => quantile(xs.map(f), 0.5);
    return {
      samples: xs.length,
      ms: median((r) => r.wallMs),
      minMs: Math.min(...xs.map((r) => r.wallMs)),
      maxMs: Math.max(...xs.map((r) => r.wallMs)),
      cpuMs: median((r) => r.localProcessCpuMs),
      gets: median((r) => r.diagnostics.requests),
      bytes: median((r) => r.diagnostics.bytes),
      verificationGets: median((r) => r.diagnostics.documentVerificationRanges),
      candidates: median((r) => r.diagnostics.packageCandidates),
      positions: median((r) => r.diagnostics.positionIntegers),
      contextBytes: median((r) => r.diagnostics.pairPositionBytes),
      scoreBlocks: median((r) => r.diagnostics.scoreBlocksFetched),
      scorePostings: median((r) => r.diagnostics.scorePostingsDecoded),
      scoreWaves: median((r) => r.diagnostics.scoreIOWaves),
      positionWaves: median((r) => r.diagnostics.positionIOWaves),
      packageWaves: median((r) => r.diagnostics.packageIOWaves),
      exactPhraseOccurrences: median(
        (r) => r.diagnostics.exactPhraseOccurrences,
      ),
      peakBuffers: median((r) => r.diagnostics.peakActiveBufferBytes),
    };
  };
  return { q, control: summarize("control"), candidate: summarize("auto") };
});
const percentile = (side: "control" | "candidate") =>
  Object.fromEntries(
    [0.5, 0.95, 0.99].map((q) => [
      q,
      quantile(
        queries.map((r) => r[side].ms),
        q,
      ),
    ]),
  );
const summary = {
  manifest: data.manifest,
  samples: data.rows.length,
  control: percentile("control"),
  candidate: percentile("candidate"),
  aggregate: Object.fromEntries(
    (["control", "candidate"] as const).map((side) => [
      side,
      Object.fromEntries(
        Object.keys(queries[0][side])
          .filter((key) => key !== "samples")
          .map((key) => {
            const xs = queries.map((r) => (r[side] as any)[key]);
            return [
              key,
              {
                sum: xs.reduce((n, x) => n + x, 0),
                p50: quantile(xs, 0.5),
                p95: quantile(xs, 0.95),
                p99: quantile(xs, 0.99),
              },
            ];
          }),
      ),
    ]),
  ),
  regressions: queries.filter(
    (r) =>
      r.candidate.ms > r.control.ms * 1.1 && r.candidate.ms > r.control.ms + 10,
  ),
  queries,
};
await mkdir(out, { recursive: true });
await writeFile(out + "/comparison.json.gz", gzipSync(JSON.stringify(data)));
await writeFile(out + "/summary.json", JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      samples: summary.samples,
      control: summary.control,
      candidate: summary.candidate,
      regressions: summary.regressions,
    },
    null,
    2,
  ),
);
for (const r of queries.filter((r) =>
  /intervention as|requests for admission|sentencing|consent decree|Rule 106/.test(
    r.q,
  ),
))
  console.log(r);
