import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const destination = "bench/results/retrieval-v2";
await mkdir(destination, { recursive: true });
const load = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const quantile = (a: number[], p: number) =>
  [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1];
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
const stats = (rows: any[], native = false) => ({
  n: rows.length,
  p50: quantile(
    rows.map((r) => r.ms),
    0.5,
  ),
  p95: quantile(
    rows.map((r) => r.ms),
    0.95,
  ),
  meanRequests: mean(
    rows.map((r) => (native ? r.diagnostics.requests : r.requests)),
  ),
  zeroR2Percent:
    (100 *
      rows.filter((r) => (native ? r.diagnostics.requests : r.requests) === 0)
        .length) /
    rows.length,
  meanBytes: mean(rows.map((r) => (native ? r.diagnostics.bytes : r.bytes))),
  meanCpu: native ? undefined : mean(rows.map((r) => r.cpuMs)),
  processPeakRssMiB: native
    ? undefined
    : Math.max(...rows.map((r) => r.processPeakRssMiB)),
  bundleBytes: native ? undefined : rows[0]?.bundleBytes,
});
const archive = async (name: string, value: unknown) =>
  writeFile(
    destination + "/" + name + ".json.gz",
    gzipSync(JSON.stringify(value), { level: 9 }),
  );
const matrix: any[] = [],
  adaptive: any[] = [];
for (const mib of [8, 16, 32, 48])
  for (const [label, target, modes] of [
    ["retrieval-frozen", matrix, ["pairs", "windows", "planned", "fine"]],
    ["retrieval-adaptive", adaptive, ["pairs", "hybrid"]],
  ] as const) {
    const f = await load(`work/global-bench/${label}-${mib}.json`);
    if (f.rows.length !== modes.length * 32) throw Error("Incomplete matrix");
    await archive(`${label}-${mib}`, f);
    for (const mode of modes)
      for (const group of ["all", "legal", "stress"])
        target.push({
          mib,
          mode,
          group,
          ...stats(
            f.rows.filter(
              (r: any) =>
                r.mode === mode && (group === "all" || r.group === group),
            ),
          ),
        });
  }
const initial = await load("work/global-bench/retrieval-final-native.json"),
  final = await load("work/global-bench/retrieval-adaptive-native.json");
if (initial.rows.length !== 256 || final.rows.length !== 192)
  throw Error("Incomplete live comparison");
const native: any[] = [];
for (const [phase, f] of [
  ["fresh-four", initial],
  ["adaptive-followup", final],
] as const) {
  await archive(phase, f);
  for (const name of f.variants)
    for (const pass of [0, 1])
      for (const group of ["all", "legal", "stress"])
        native.push({
          phase,
          name,
          pass,
          group,
          ...stats(
            f.rows.filter(
              (r: any) =>
                r.name === name &&
                r.pass === pass &&
                (group === "all" || r.group === group),
            ),
            true,
          ),
        });
}
const cpus: any[] = [];
for (const [label, f] of [
  ["retrieval-final-native", initial],
  ["retrieval-adaptive-native", final],
] as const) {
  const trace = await load(`work/global-bench/${label}-cpu.json`);
  await archive(label + "-cpu", trace);
  const queries = new Set(f.rows.map((r: any) => r.q));
  for (const name of f.variants) {
    const rows = trace.rows.filter(
      (r: any) =>
        r.name === name && queries.has(r.q) && typeof r.cpuMs === "number",
    );
    cpus.push({
      phase: label,
      name,
      samples: rows.length,
      expected: 64,
      p50Cpu: quantile(
        rows.map((r: any) => r.cpuMs),
        0.5,
      ),
      p95Cpu: quantile(
        rows.map((r: any) => r.cpuMs),
        0.95,
      ),
      meanCpu: mean(rows.map((r: any) => r.cpuMs)),
    });
  }
}
const source = await load("work/global-100k/manifest.json"),
  fine = await load("work/global-100k-fine16-v2/manifest.json"),
  pairs = await load("work/pairs-100k-v4096-inline256/manifest.json");
await copyFile(
  "work/pairs-100k-v4096-inline256/costs.bin",
  destination + "/costs.bin",
);
await archive("fine-manifest", fine);
await archive(
  "pair-cost-build",
  await load("work/retrieval-round2/pair-cost-build.json"),
);
await archive(
  "seed-ablation",
  await load("work/global-bench/round2-fine-pilot-cpu.json"),
);
await archive(
  "host-frozen",
  await load("work/retrieval-bench/retrieval-frozen-host.json"),
);
await archive(
  "host-adaptive",
  await load("work/retrieval-bench/retrieval-adaptive-host.json"),
);
const deployments: any[] = [];
for (const profile of ["base", "window", "cost", "fine"]) {
  const log = await readFile(
    `work/retrieval-round2/deploy-final-${profile}.log`,
    "utf8",
  );
  deployments.push({
    profile,
    startupMs: Number(log.match(/Worker Startup Time: (\d+) ms/)?.[1]),
    uploadKiB: Number(log.match(/Total Upload: ([\d.]+) KiB/)?.[1]),
    gzipKiB: Number(log.match(/gzip: ([\d.]+) KiB/)?.[1]),
    version: log.match(/Current Version ID: ([a-f0-9-]+)/)?.[1],
  });
}
const health = [];
for (const name of [...initial.variants, "work-search-r2-hybrid"]) {
  const r = await fetch(`https://${name}.phulin.workers.dev/health`);
  if (!r.ok) throw Error("Health");
  health.push({ name, ...((await r.json()) as object) });
}
const summary = {
  version: 1,
  date: new Date().toISOString(),
  controlCommit: "4f97eb49f1aa2115fbc3026c4924a1182a90917b",
  corpus: {
    documents: 100000,
    terms: source.terms,
    generation: source.generation,
    pairGeneration:
      initial.rows[0]?.diagnostics?.pairGeneration ?? pairs.generation,
  },
  storage: {
    baseBytes: source.objects.reduce((n: number, o: any) => n + o.size, 0),
    extraPlanBytes: fine.objects
      .slice(source.objects.length)
      .reduce((n: number, o: any) => n + o.size, 0),
    pairCostBytes: 286595,
    pairRootBytes: 151816,
  },
  matrix,
  adaptive,
  native,
  cpus,
  deployments,
  health,
};
await writeFile(
  destination + "/summary.json",
  JSON.stringify(summary, null, 2),
);
const n = (v: number) => Math.round(v).toLocaleString("en-US"),
  ms = (v: number) => n(v) + " ms",
  one = (v: number) => v.toFixed(1);
const table = (head: string[], rows: (string | number)[][]) =>
  "| " +
  head.join(" | ") +
  " |\n| " +
  head.map(() => "---").join(" | ") +
  " |\n" +
  rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
const all = matrix.filter((r) => r.group === "all"),
  aa = adaptive.filter((r) => r.group === "all"),
  nn = native.filter((r) => r.group === "all");
let report = `# Retrieval optimization round 2\n\nMeasured on 100,000 Free Law Project opinions against commit \`4f97eb4\`. No query-workload-selected phrase index was added. Every measured top-20 response was checked for IDs, BM25 scores (relative tolerance 1e-11), title and metadata against the materialized source oracle. Snippets were included in latency measurements. Full-corpus production search/import was not switched.\n\n## Outcome\n\nDo not enable these experiments globally yet. In the final 8 MiB comparison, cold simulated P95 fell from 3,956 to 3,470 ms and reads/query from 52.8 to 48.3. The live repeated adaptive follow-up regressed from 172/987 ms P50/P95 to 320/1,157 ms. Broad Boolean and one broad proximity query improved individually, but the complete workload did not. All new execution switches remain off by default. The next investigation should profile fine-plan decoding/allocation and cache-operation overhead before attempting further global promotion.\n\n## What was implemented, in sequence\n\n1. Mandatory rare-position anchors verify phrases/proximity inside existing independently compressed token frames. Exact coverage proofs and sorted rows are required; title/boundary/negative/unbounded cases fall back. Verified frames can supply excerpts.\n2. A corpus-derived, generation-pinned pair-cost synopsis plus local unigram DF avoids unhelpful pair reads. Missing fingerprints are unknown. Useful multi-pair intersections remain. Positional cofetching reuses pages already selected for frequencies, within the original expanded-byte cap.\n3. Exact bounded seed completion was implemented and tested, then left off: pilots added reads without reducing visited cells. Conservative 16-document score bounds replace 64-document bounds in a separately packed layout. A live-driven adaptive pass keeps coarse bounds for selective proximity, gates text windows to small/rare candidate sets, and gates cofetching to small candidate sets.\n\nThe first maximum-sketch/individual-pair pilots lost useful pair intersections and were rejected. A stricter 25% pair gate was relaxed to 75%. Unconditional windows and fine/cofetch execution regressed some live queries; the adaptive profile is a separate measured follow-up. These outcomes are retained rather than presenting all three as automatic wins.\n\n## Cold simulated R2: all four budgets\n\nFixed per-page empirical headers/body latency from the earlier real R2 calibration; six header slots, overlapping bodies, 256 KiB physical pages, 8 MiB query page memory, cold per-query memory, no shared cache or response cache. Each budget ran in its own process (four concurrent processes); profiles alternate order by query. CPU is process CPU, and latency includes host scheduling. These are simulated storage results, not deployed Cloudflare latency. The four-stage matrix contains 512 verified responses.\n\n${table(
  [
    "MiB",
    "Stage",
    "P50",
    "P95",
    "R2 reads/query",
    "CPU mean",
    "Index data bytes",
  ],
  all.map((r) => [
    r.mib,
    r.mode,
    ms(r.p50),
    ms(r.p95),
    one(r.meanRequests),
    ms(r.meanCpu),
    n(r.bundleBytes),
  ]),
)}\n\nStages: \`pairs\` = original committed executor plus the existing rare/multi-pair sidecar; \`windows\` = step 1; \`planned\` = step 2; \`fine\` = unconditional fine-bound layout without seed completion.\n\nThe final adaptive follow-up contains another 256 verified responses:\n\n${table(
  ["MiB", "Profile", "P50", "P95", "R2 reads/query", "CPU mean"],
  aa.map((r) => [
    r.mib,
    r.mode,
    ms(r.p50),
    ms(r.p95),
    one(r.meanRequests),
    ms(r.meanCpu),
  ]),
)}\n\n## Live Workers, 8 MiB\n\nFour fresh Worker/cache namespaces received identical corpus-frequency, IDs-only index primes, then interleaved unfamiliar queries and a repeated pass. Isolate-local memory was reset before every query. The shared Cache API stores immutable index pages; no complete-response cache exists. All 256 responses matched the source oracle. Client end-to-end latency includes metadata and matching excerpts. All measurements in this run were collected in ${[...new Set(initial.rows.map((r: any) => r.colo))].join(", ")}.\n\n${table(
  ["Profile", "Pass", "P50", "P95", "R2 reads/query"],
  nn
    .filter((r) => r.phase === "fresh-four")
    .map((r) => [
      r.name.split("-").at(-1),
      r.pass === 0 ? "unfamiliar / index primed" : "repeated / pages warm",
      ms(r.p50),
      ms(r.p95),
      one(r.meanRequests),
    ]),
)}\n\nThe live regressions prompted adaptive retrieval. Its follow-up compares the existing warmed control/fine namespaces with a fresh hybrid namespace, then repeats all queries. **Only the repeated pass is cache-comparable across all three**; first-pass raw results are archived but must not be described as a fair unfamiliar-query comparison. No response cache is used. Another 192 responses matched the oracle.\n\n${table(
  ["Profile", "Repeated P50", "Repeated P95", "R2 reads/query"],
  nn
    .filter((r) => r.phase === "adaptive-followup" && r.pass === 1)
    .map((r) => [
      r.name.split("-").at(-1),
      ms(r.p50),
      ms(r.p95),
      one(r.meanRequests),
    ]),
)}\n\nPer-query repeated latency in the adaptive follow-up:\n\n${table(
  ["Query", "Control", "Fine", "Adaptive"],
  final.rows
    .filter((r: any) => r.name === "work-search-r2-hybrid" && r.pass === 1)
    .map((r: any) => [
      r.q.replaceAll("|", "\\|"),
      ...[
        "work-search-r2-final-base",
        "work-search-r2-final-fine",
        "work-search-r2-hybrid",
      ].map((name) =>
        ms(
          final.rows.find(
            (x: any) => x.name === name && x.pass === 1 && x.q === r.q,
          ).ms,
        ),
      ),
    ]),
)}\n\n## CPU, startup, memory and storage\n\nLive CPU comes from sanitized Cloudflare tail events, including the provider's request lifecycle/deferred work. Tail coverage can be sampled. CPU tables aggregate both passes and are not a substitute for matched client latency; the adaptive run has different first-pass cache histories. Expected main-query coverage is 64 per Worker. Raw authorization headers were never archived.\n\n${table(
  ["Run", "Profile", "CPU samples", "CPU P50", "CPU P95", "CPU mean"],
  cpus.map((r) => [
    r.phase,
    r.name.split("-").at(-1),
    r.samples + "/64",
    ms(r.p50Cpu),
    ms(r.p95Cpu),
    ms(r.meanCpu),
  ]),
)}\n\nWrangler measured deployment startup (one observation, not a startup distribution):\n\n${table(
  ["Profile", "Startup", "Total upload KiB", "Gzip KiB"],
  deployments.map((r) => [r.profile, ms(r.startupMs), r.uploadKiB, r.gzipKiB]),
)}\n\nThe new layout adds ${n(summary.storage.extraPlanBytes)} bytes (${(summary.storage.extraPlanBytes / 2 ** 30).toFixed(3)} GiB) of immutable plan data; ${n(summary.storage.baseBytes)} original bytes are shared. Only the new 11 objects were uploaded. Binary bundle budgets include the base root, pair root and synopsis; code/runtime overhead is separate and Wrangler's gzip deployment sizes are shown above. Fine/hybrid combined binary bytes are 8,033,261 / 15,722,647 / 31,063,338 / 46,344,979. The synopsis is 286,595 bytes and took about 6.6 seconds to build; fine-plan construction took ${(fine.microMs / 1000).toFixed(1)} seconds excluding subsequent display-head packing.\n\nThe simulated process peak RSS includes the legacy oracle, Node buffers and retained GC heap; it is **not Worker isolate memory**. Its per-profile values are in summary.json. Actual peak isolate memory was not exposed by this harness. Native testing used 8 MiB only; 16/32/48 MiB results above are local simulation, not live memory/startup validation.\n\n## Interpretation and limitations\n\nThese are 32 scenarios, not a representative user traffic distribution. P95 is nearest rank over 32 values (second slowest); within 16-query legal/stress groups it is the slowest. Group statistics, individual traces, bytes, storage stages and zero-R2 percentages are in the machine-readable files. Broad proximity still takes well over the experimental 200–400 ms complete-response goal. Larger bundles do not automatically help this page-heavy workload. Repeat runs and fresh-cache adaptive tests are needed before changing production defaults.\n\nSeed completion remains implemented but off. Bare windows should not be promoted globally: their cold-read regressions are real. The adaptive profile is opt-in and the full-corpus production demo stays unchanged. No claim is made that the full FLP corpus or 48 MiB isolates received these measured gains.\n\n## Reproduce\n\n\`\`\`sh\nnpm ci\nnpm run check && npm test\n# Existing 100k source/global/pair generations and calibration are required.\nnpm run global:build-pair-costs -- work/pairs-100k-v4096-inline256 work/global-100k/bundle-heads-8.bin\nnpm run global:refine-bounds -- work/global-100k work/global-100k-fine16-new 16 438411\nmkdir -p work/retrieval-round2/baseline\ngit archive 4f97eb4 src | tar -x -C work/retrieval-round2/baseline\nGLOBAL_BASELINE_SEARCH=work/retrieval-round2/baseline/src/global/search.ts \\\nGLOBAL_PAIRS=work/pairs-100k-v4096-inline256 GLOBAL_FINE_DIR=work/global-100k-fine16-new \\\nGLOBAL_MATRIX_LABEL=retrieval-check GLOBAL_MATRIX_CONCURRENCY=4 \\\nGLOBAL_PROFILES=pairs,windows,planned,fine npm run bench:global-retrieval\n# Follow-up: GLOBAL_PROFILES=pairs,hybrid and a new matrix label.\n# Deploy separate Workers first; credentials and buckets are account-specific.\nGLOBAL_NATIVE_VARIANTS=worker-control,worker-experiment \\\nGLOBAL_NATIVE_LABEL=my-live-run npm run bench:global-native-retrieval\n\`\`\`\n\nThe native harness uses the configured phulin.workers.dev benchmark account and per-Worker deploy configs; adapt that hostname and local secret location for another account. Generic publication is \`global:deploy\`, with \`GLOBAL_PAIR_COSTS=1 GLOBAL_TOKEN_WINDOWS=1 GLOBAL_COFETCH_POSITIONS=1 GLOBAL_ADAPTIVE_RETRIEVAL=1 GLOBAL_PAIR_INTERSECT=1\`. Seed completion stays off. See README for deployment and safe layout retention. Run \`npx tsx bench/global-retrieval-report.ts\` with the recorded input paths to regenerate this report.\n`;
await writeFile("bench/RETRIEVAL-ROUND2.md", report);
console.log(
  JSON.stringify(
    {
      simulated: matrix.filter((r) => r.group === "all"),
      adaptive: aa,
      live: nn.filter((r) => r.phase === "adaptive-followup" && r.pass === 1),
    },
    null,
    2,
  ),
);
