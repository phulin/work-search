import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
import { generate } from "../src/cli/generate.js";
const args = process.argv.slice(2),
  arg = (k: string, d: string) => {
    const i = args.indexOf("--" + k);
    return i < 0 ? d : args[i + 1];
  };
const sizes = arg("sizes", "10000,100000,1000000").split(",").map(Number),
  budgets = arg("budgets", "8,16,32,48").split(",").map(Number);
await mkdir("bench/generated", { recursive: true });
await mkdir("bench/results", { recursive: true });
const queries = args.includes("--queries")
  ? (await readFile(arg("queries", ""), "utf8")).split("\n").filter(Boolean)
  : [
      "document",
      "search engine",
      "category1",
      "word0",
      "word19999",
      "word12345",
      "category1 word0",
      "word0 word19999",
      "word10 word20",
      "missing",
      "word1000 word2000",
      "category99 word19998",
    ];
await writeFile("bench/generated/queries.txt", queries.join("\n"));
const results: any[] = [];
for (const n of sizes) {
  const input = arg("input", `bench/generated/corpus-${n}.jsonl`);
  if (!args.includes("--input")) await generate(input, n);
  for (const budget of budgets)
    for (const strategy of ["smallest", "workload"]) {
      const name = `${n}-${budget}-${strategy}`,
        out = join("bench/generated", name),
        result = join("bench/results", name + ".json");
      await rm(out, { recursive: true, force: true });
      console.log(`Benchmark ${name}`);
      const p = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "bench/task.ts",
          input,
          out,
          String(budget),
          strategy,
          "bench/generated/queries.txt",
          result,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      if (p.status !== 0) throw new Error(p.stderr || p.stdout);
      const row = JSON.parse(await readFile(result, "utf8"));
      results.push({ documents: n, budgetMiB: budget, strategy, ...row });
      console.log(
        row.status === "ok"
          ? `${row.buildMs.toFixed(0)}ms build, ${row.zeroReadPercent.toFixed(1)}% local, P95 ${row.p95Ms.toFixed(2)}ms`
          : row.error,
      );
      await writeFile(
        "bench/results/results.json",
        JSON.stringify(
          {
            environment: {
              date: new Date().toISOString(),
              platform: os.platform(),
              arch: os.arch(),
              cpu: os.cpus()[0].model,
              node: process.version,
              queryMode:
                "Node HTTP handler + filesystem ranges, warm OS cache; not Cloudflare latency",
            },
            results,
          },
          null,
          2,
        ),
      );
    }
}
const mb = (n: number) => (n / 1048576).toFixed(2);
let report = `# Local benchmark report\n\nMeasured ${new Date().toISOString()} on ${os.cpus()[0].model}, ${os.platform()}/${os.arch()}, Node ${process.version}.\n\nDeterministic seed 42; 40 sampled vocabulary tokens plus 4 common/category tokens per document; 20,000-word vocabulary. ${queries.length} queries, three passes each, ID-only AND, top 20. Includes common, rare, mixed and missing terms. Workload selection is evaluated on its training queries, so its advantage is optimistic.\n\nLatency is the in-process HTTP handler with filesystem ranged reads and warm OS caches. It is **not deployed Cloudflare latency**, and excludes public-network transport. Peak RSS is measured in a fresh child process per build/configuration and includes Node and the builder. CPU is process user+system time, not Worker billing CPU. Constructor timing measures 100 binary-view constructions, not isolate startup.\n\n|Docs|MiB budget|Strategy|Build s|Docs/s|Bundle MiB|Storage MiB|Zero reads %|Reads/query|Bytes/query|P50 ms|P95 ms|CPU ms/query|Peak RSS MiB|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const r of results)
  report +=
    r.status === "ok"
      ? `|${r.documents}|${r.budgetMiB}|${r.strategy}|${(r.buildMs / 1000).toFixed(2)}|${r.throughput.toFixed(0)}|${mb(r.bundleBytes)}|${mb(r.storageBytes)}|${r.zeroReadPercent.toFixed(1)}|${r.avgRequests.toFixed(2)}|${r.avgBytes.toFixed(0)}|${r.p50Ms.toFixed(2)}|${r.p95Ms.toFixed(2)}|${r.avgCpuMs.toFixed(2)}|${mb(r.queryPeakRssBytes)}|\n`
      : `|${r.documents}|${r.budgetMiB}|${r.strategy}|infeasible: mandatory tables exceed budget||||||||||\n`;
report += `\n## Interpretation and costs\n\nThe 10k corpus can fit entirely in the bundle, so budgets larger than that index do not improve I/O. At larger sizes, mandatory external IDs and document lengths consume meaningful space before embedding any postings. An infeasible budget is rejected rather than silently exceeded. Query failures, if any, are preserved in per-query JSON samples and excluded from latency percentiles; inspect those samples before comparing configurations.\n\nR2 Standard list prices checked 2026-11-11: $0.015/GB-month storage, $0.36/million Class B reads, $4.50/million Class A writes, zero Internet egress fee. Before free tiers, estimated monthly R2 cost = remote bytes / 1e9 * 0.015 + monthly queries / 1e6 * average reads * 0.36. Metadata reads add separately; benchmark queries omit metadata. For one million monthly queries, the read charge is $0.36 times reads/query. These are estimates, not an account invoice. Workers Paid adds a $5/month minimum, usage beyond included request/CPU allowances, and deployment storage may vary. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).\n\nNo Cloudflare account was used. Run bench/remote.ts against a deployed URL for genuine network latency, and use Workers analytics for server-side CPU and memory.\n`;
await writeFile("bench/REPORT.md", report);
