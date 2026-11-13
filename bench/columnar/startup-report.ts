import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
const label = process.argv[2] ?? "packets-1m-startup",
  input = await readFile(`work/columnar-bench/${label}.json`),
  data = JSON.parse(input.toString()),
  cpuBytes = await readFile(`work/columnar-bench/${label}-cpu.json.gz`),
  cpu = JSON.parse(gunzipSync(cpuBytes).toString()),
  byId = new Map(cpu.rows.map((r: any) => [r.requestId, r])),
  trials = await Promise.all(
    data.rows.map(async (row: any, i: number) => {
      const probe = row.manifest.deploymentProbe,
        last = probe.attempts.at(-1),
        native: any = byId.get(last.requestId),
        log = await readFile(
          `work/columnar-bench/${label}-deploy-${i}.log`,
          "utf8",
        );
      return {
        condition: row.condition,
        q: row.q,
        ms: last.ms,
        cpuMs: native?.cpuMs,
        nativeWallMs: native?.wallMs,
        status: last.status,
        correct: last.correct,
        version: last.result.telemetry?.version,
        requestNumber: last.result.telemetry?.requestNumber,
        requestId: last.requestId,
        isolate: last.result.telemetry?.isolate,
        diagnostics: last.result.diagnostics,
        attempts: probe.attempts.length,
        sourceHash: row.manifest.sourceHash,
        generation: row.manifest.generation,
        reportedModuleStartupMs: Number(
          log.match(/Worker Startup Time: (\d+) ms/)?.[1],
        ),
        preparation: row.preparation,
      };
    }),
  ),
  report = {
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    count: data.count,
    corpusHash: data.corpusHash,
    region: data.region,
    caveats: data.caveats,
    trials,
  };
await writeFile(`bench/results/columnar/${label}.json.gz`, gzipSync(input));
await writeFile(`bench/results/columnar/${label}-cpu.json.gz`, cpuBytes);
await writeFile(
  `bench/results/columnar/${label}-summary.json`,
  JSON.stringify(report, null, 2),
);
console.log(
  trials.map(
    ({
      condition,
      q,
      ms,
      cpuMs,
      requestNumber,
      correct,
      reportedModuleStartupMs,
    }) => ({
      condition,
      q,
      ms,
      cpuMs,
      requestNumber,
      correct,
      reportedModuleStartupMs,
    }),
  ),
);
