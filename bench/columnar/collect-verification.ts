/** Collect sanitized, self-contained evidence for the document-format iteration. */
import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
const out = "bench/results/columnar/verification-1m";
await mkdir(out, { recursive: true });
const liveContract = JSON.parse(
    await readFile("work/verification-live-contract.json", "utf8"),
  ),
  firstSearch = liveContract.scenarios.find(
    (s: any) =>
      s.q.includes('"summary judgment" AND arbitration') &&
      s.options.exactTotal,
  );
if (!firstSearch) throw Error("Missing deployment probe");
await writeFile(
  "work/verification-first-search.json",
  JSON.stringify({
    ...firstSearch,
    oracle: firstSearch.oracleByVariant.candidate,
  }),
);
for (const name of [
  "verification-measured-empty",
  "verification-measured-reuse",
  "verification-measured-shared",
  "verification-final-200",
  "verification-independent-160",
])
  await cp(`work/columnar-bench/${name}.json.gz`, `${out}/${name}.json.gz`);
for (const name of [
  "documents",
  "terms",
  "pairs",
  "positions",
  "prefix",
  "presence",
])
  await cp(
    `work/verification-1m/${name}-report.json`,
    `${out}/${name}-report.json`,
  );
for (const [source, name] of [
  ["work/io-iteration/contract.json", "local-contract.json"],
  ["work/io-iteration/expanded-contract.json", "research-contract.json"],
  ["work/io-iteration/oracle-160.json", "independent-contract.json"],
  ["work/verification-live-contract.json", "live-contract.json"],
  ["work/verification-1m/root.json", "root.json"],
  ["work/verification-results/summary.json", "local-summary.json"],
])
  await writeFile(`${out}/${name}.gz`, gzipSync(await readFile(source)));
const quantiles = (values: number[]) => {
  values.sort((a, b) => a - b);
  return Object.fromEntries(
    [0.5, 0.95, 0.99].map((q) => [
      "p" + 100 * q,
      values[Math.min(values.length - 1, Math.floor(values.length * q))],
    ]),
  );
};
const data = JSON.parse(
  gunzipSync(
    await readFile("work/columnar-bench/verification-final-200.json.gz"),
  ).toString(),
);
const population = ["control", "auto"].map((variant) => {
  const rows = data.rows.filter((r: any) => r.plan.startsWith(variant));
  return {
    variant,
    n: rows.length,
    wallMs: quantiles(rows.map((r: any) => r.wallMs)),
    processCpuMs: quantiles(rows.map((r: any) => r.localProcessCpuMs)),
  };
});
const profiles: any[] = [];
for (const variant of ["control", "candidate"]) {
  const dir = "work/verification-profiles/" + variant;
  await cp(dir, out + "/profiles/" + variant, { recursive: true });
  const data = JSON.parse(await readFile(dir + "/summary.json", "utf8"));
  profiles.push({
    variant,
    rows: data.rows.map((r: any) => ({
      q: r.q,
      options: r.options,
      sid: r.sid,
      selfMicros: Object.entries(r.selfMicros).slice(0, 12),
      sampledAllocationBytes: Object.values(r.sampledAllocationBytes).reduce(
        (n: number, b: any) => n + b,
        0,
      ),
      largestAllocations: Object.entries(r.sampledAllocationBytes).slice(0, 8),
      processMemory: r.processMemory,
    })),
  });
}
const root = JSON.parse(
  await readFile("work/verification-1m/root.json", "utf8"),
);
const manifest = {
  corpusHash: root.corpusHash,
  generation: root.generation,
  count: root.count,
  analysis: root.analysis,
  localControlSourceCommit: "5d897ff9aba0300e49b9d4890e6d1a452960d7a9",
  localControlGeneration:
    "516d94f78ae930e1a1462d8ca590a5a882347fd6412b3e8749964ee0d250e436",
  initialImplementationCommit: "614141e",
  notes: [
    "Local control uses identical candidate passage bytes in the frozen CDP3 arrangement.",
    "Local complete-response simulation and CPU diagnostics are not live Worker measurements.",
    "Workload quantiles weight each query equally and are not production traffic percentiles.",
    "Heap samples estimate cumulative allocation including collected objects, not retained or peak memory.",
  ],
  population,
  profiles,
  artifacts: [] as { name: string; bytes: number; sha256: string }[],
};
for (const name of (await readdir(out)).sort()) {
  if (name === "provenance.json" || name === "profiles") continue;
  const raw = await readFile(out + "/" + name);
  manifest.artifacts.push({
    name,
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
}
await writeFile(out + "/provenance.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ population, profiles }, null, 2));
