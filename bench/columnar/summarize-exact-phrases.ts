import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const [output, ...files] = process.argv.slice(2);
if (!files.length)
  throw Error("Usage: summarize-exact-phrases.ts OUTPUT.json RESULTS.gz...");
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
    : { n };
};
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
  "wordPositionBlocks",
  "wordPositionBytes",
  "exactPhraseReads",
  "exactPhraseBytes",
  "exactPhraseOccurrences",
  "exactPhraseMatches",
  "peakExactPhraseBufferBytes",
  "documentVerificationBytes",
  "documentPresentationBytes",
  "metadataMs",
  "peakActiveBufferBytes",
  "decodedBytes",
  "repeatedDecodedBytes",
  "inflatedBytes",
  "repeatedInflatedBytes",
];
const runs = [];
for (const path of files) {
  const data = JSON.parse(gunzipSync(await readFile(path)).toString()),
    groups = new Map<string, any[]>();
  for (const r of data.rows) {
    const k = JSON.stringify([r.q, r.options, r.plan]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  runs.push({
    path,
    manifest: data.manifest,
    attempts: data.rows.length,
    errors: data.rows.filter((r: any) => r.error || r.unsupported),
    groups: [...groups].map(([k, rows]) => ({
      key: JSON.parse(k),
      n: rows.length,
      wallMs: distribution(rows.map((r) => r.wallMs)),
      processCpuMs: distribution(rows.map((r) => r.localProcessCpuMs)),
      counters: Object.fromEntries(
        metrics.map((m) => [
          m,
          distribution(rows.map((r) => r.diagnostics?.[m])),
        ]),
      ),
      executors: [...new Set(rows.map((r) => r.diagnostics?.executor))],
      phrasePlans: rows[0]?.diagnostics?.exactPhrasePlans,
    })),
  });
}
await writeFile(
  output,
  JSON.stringify(
    {
      note: "Randomized/interleaved local simulation, not native Worker latency. Per-query medians and observed ranges; no production percentile claim.",
      runs,
    },
    null,
    2,
  ),
);
for (const r of runs)
  console.log(
    r.manifest.condition,
    r.attempts,
    "responses",
    r.errors.length,
    "errors",
  );
