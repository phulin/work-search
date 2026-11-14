/** Collect complete-coverage evidence without corpus payloads or credentials. */
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
const out = "bench/results/columnar/exact-phrases-1m",
  index = "work/complete-context-v2-1m",
  live = process.argv.includes("--live");
await mkdir(out, { recursive: true });
async function copy(from: string, name: string) {
  await copyFile(from, out + "/" + name);
}
async function json(from: string, name: string) {
  await writeFile(
    out + "/" + name + ".json.gz",
    gzipSync(await readFile(from)),
  );
}
for (const condition of ["empty", "shared", "reuse", "200", "independent"])
  await copy(
    `work/columnar-bench/complete-context-final-${condition}.json.gz`,
    `local-${condition}.json.gz`,
  );
for (const name of [
  "context-coverage",
  "context-validation",
  "complete-context-report",
  "positions-report",
])
  await json(`${index}/${name}.json`, name);
await copy(index + "/exact-phrases.bin", "exact-phrases.bin");
await json("work/exact-phrases-contract.json", "representative-contract");
await json("work/complete-context-local-summary.json", "local-summary");
const local = JSON.parse(
    await readFile("work/complete-context-local-summary.json", "utf8"),
  ),
  wide = local.runs.find((r: any) => r.attempts === 800),
  byQuery = new Map<string, any[]>();
for (const g of wide.groups) {
  const key = JSON.stringify(g.key.slice(0, 2));
  if (!byQuery.has(key)) byQuery.set(key, []);
  byQuery.get(key)!.push(g);
}
const comparisons = [...byQuery.values()].map((gs) => {
  const c = gs.find((g) => g.key[2].startsWith("control")),
    a = gs.find((g) => g.key[2].startsWith("auto"));
  return {
    q: a.key[0],
    options: a.key[1],
    controlMs: c.wallMs.median,
    candidateMs: a.wallMs.median,
    deltaMs: a.wallMs.median - c.wallMs.median,
    controlRange: [c.wallMs.min, c.wallMs.max],
    candidateRange: [a.wallMs.min, a.wallMs.max],
    controlCpuMs: c.processCpuMs.median,
    candidateCpuMs: a.processCpuMs.median,
  };
});
const percentile = (values: number[], p: number) => {
  const a = [...values].sort((a, b) => a - b),
    n = a.length;
  return p === 0.5 && n % 2 === 0
    ? (a[n / 2 - 1] + a[n / 2]) / 2
    : a[Math.ceil(n * p) - 1];
};
await writeFile(
  out + "/queries-200.json",
  JSON.stringify(
    {
      note: "Shared-warm local simulation with empty application caches, two observations per engine per query. Percentiles below are over 200 query medians, not traffic percentiles.",
      attempts: wide.attempts,
      errors: wide.errors,
      scenarioPercentiles: [0.5, 0.95, 0.99].map((p) => ({
        p,
        controlMs: percentile(
          comparisons.map((r) => r.controlMs),
          p,
        ),
        candidateMs: percentile(
          comparisons.map((r) => r.candidateMs),
          p,
        ),
      })),
      comparisons,
    },
    null,
    2,
  ),
);
const quote = (s: unknown) => '"' + String(s).replaceAll('"', '""') + '"';
await writeFile(
  out + "/queries-200.csv",
  [
    [
      "query",
      "options",
      "control_ms",
      "candidate_ms",
      "delta_ms",
      "control_min_ms",
      "control_max_ms",
      "candidate_min_ms",
      "candidate_max_ms",
      "control_cpu_ms",
      "candidate_cpu_ms",
    ].join(","),
    ...comparisons.map((r) =>
      [
        r.q,
        JSON.stringify(r.options),
        r.controlMs,
        r.candidateMs,
        r.deltaMs,
        ...r.controlRange,
        ...r.candidateRange,
        r.controlCpuMs,
        r.candidateCpuMs,
      ]
        .map(quote)
        .join(","),
    ),
  ].join("\n") + "\n",
);
await json("work/io-iteration/expanded-contract.json", "expanded-200-contract");
await json("work/io-iteration/oracle-160.json", "independent-160-contract");
const profiles = "work/columnar-profile/complete-context-1m";
for (const name of await readdir(profiles))
  if (/\.(cpu|heap)profile\.gz$/.test(name))
    await copy(profiles + "/" + name, name);
await json(profiles + "/requests.json", "native-profile-requests");
await json(
  "bench/results/columnar/profiles/complete-context-1m/summary.json",
  "native-profile-summary",
);
const usage = [];
for (const name of (await readdir("work/complete-context-usage")).sort())
  if (name.endsWith(".json"))
    usage.push(
      JSON.parse(await readFile("work/complete-context-usage/" + name, "utf8"))
        .summary,
    );
await writeFile(out + "/cloudflare-usage.json", JSON.stringify(usage, null, 2));
for (const name of ["tests", "typecheck"])
  await writeFile(
    out + "/" + name + ".log.gz",
    gzipSync(await readFile(`work/complete-context-final-${name}.log`)),
  );
if (live) {
  await copy("work/columnar-bench/exact-phrases-live.json.gz", "live.json.gz");
  await copy(
    "work/columnar-bench/exact-phrases-live-cpu.json.gz",
    "live-native.json.gz",
  );
  await json("work/exact-phrases-live-contract.json", "live-contract");
  await json("work/exact-phrases-live-summary.json", "live-summary");
  const deployment = "work/columnar-deploy/work-search-cws-phrase-1m";
  for (const suffix of ["manifest", "first-search"])
    await json(deployment + "-" + suffix + ".json", "deployment-" + suffix);
}
const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  report = JSON.parse(await readFile(index + "/positions-report.json", "utf8")),
  files = [];
for (const name of (await readdir(out))
  .filter((n) => n !== "provenance.json")
  .sort()) {
  const raw = await readFile(out + "/" + name);
  files.push({
    name,
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
}
await writeFile(
  out + "/provenance.json",
  JSON.stringify(
    {
      controlCommit: (
        await readFile("work/phrase-control/commit", "utf8")
      ).trim(),
      implementationCommit: "d3dfe06",
      collectionCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      generation: root.generation,
      corpusHash: root.corpusHash,
      documents: root.count,
      analysis: root.analysis,
      exactPhraseGeneration: report.generation,
      routerSha256: createHash("sha256")
        .update(await readFile(index + "/router.bin"))
        .digest("hex"),
      responseCaching: false,
      membershipEncoding: "sorted integer lists",
      contextCoverage: "every observed pair, every occurrence",
      live,
      note: "Full-coverage finalist only. Superseded limited-pair experiments are excluded. Local simulations and native attribution are distinguished from live measurements.",
      files,
    },
    null,
    2,
  ),
);
console.log("Collected", files.length, "evidence files in", out);
