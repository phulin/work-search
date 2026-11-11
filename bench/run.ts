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
              format: row.format,
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
await import("./report.js");
await import("./details.js");
await import("./connectors-report.js");
