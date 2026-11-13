import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";
const name = "work-search-cws-startup",
  label = process.env.CWS_LABEL ?? "packets-1m-startup",
  data = process.env.CWS_STARTUP_DATA ?? "work/columnar-packets-1m-pairs-dense",
  token = await benchmarkToken(),
  oracle = JSON.parse(
    await readFile(
      process.env.CWS_SCENARIOS ?? "work/columnar-bench/oracle-worker-1m.json",
      "utf8",
    ),
  ),
  queries = [12, 14, 48].map((i) => oracle.scenarios[i]),
  rows: any[] = [],
  startedAt = new Date().toISOString();
await mkdir("work/columnar-bench", { recursive: true });
async function run(
  args: string[],
  log: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const chunks: Buffer[] = [];
  await new Promise<void>((ok, no) => {
    const child = spawn("yarn", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => chunks.push(b));
    child.once("error", no);
    child.once("exit", async (c) => {
      await writeFile(log, Buffer.concat(chunks));
      c === 0 ? ok() : no(Error("Startup command failed; see " + log));
    });
  });
}
const save = () =>
  writeFile(
    `work/columnar-bench/${label}.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        name,
        data,
        corpusHash: oracle.corpusHash,
        count: oracle.count,
        region: "local-New-England",
        rows,
        caveats: [
          "Small deployment pilot, not a P99 estimate.",
          "Application reset is used only to prepare shared pages before deployment. Measured searches follow actual deployments without a reset or health probe.",
          "Worker version, isolate and request sequence are observed, not assumed. Opaque R2 caches and platform startup preparation are uncontrolled.",
        ],
      },
      null,
      2,
    ),
  );
try {
  for (const condition of ["fresh-namespace", "shared-warm"])
    for (const query of queries) {
      const index = rows.length,
        preparation: any[] = [],
        namespace = `startup-${crypto.randomUUID()}`;
      if (condition === "shared-warm") {
        for (let attempt = 0; attempt < 6; attempt++) {
          const response = await fetch(
              `https://${name}.phulin.workers.dev/search`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  q: query.q,
                  ...query.options,
                  cacheNamespace: namespace,
                  resetMemory: true,
                }),
                signal: AbortSignal.timeout(120000),
              },
            ),
            result = (await response.json()) as any;
          preparation.push({
            status: response.status,
            diagnostics: result.diagnostics,
            telemetry: result.telemetry,
          });
          if (
            response.ok &&
            result.diagnostics?.requests === 0 &&
            result.diagnostics?.sharedGets > 0
          )
            break;
          if (attempt === 5)
            throw Error("Could not establish warm shared pages");
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      const contractPath = `work/columnar-bench/${label}-contract.json`;
      await writeFile(contractPath, JSON.stringify(query));
      await run(
        [
          "node",
          "--import",
          "tsx",
          "scripts/deploy-columnar.ts",
          data,
          name,
          "--deploy-only",
          "--first-search",
          contractPath,
        ],
        `work/columnar-bench/${label}-deploy-${index}.log`,
        { ...process.env, CWS_NAMESPACE: namespace },
      );
      const manifest = JSON.parse(
        await readFile(`work/columnar-deploy/${name}-manifest.json`, "utf8"),
      );
      rows.push({ condition, namespace, q: query.q, preparation, manifest });
      await save();
      const probe = manifest.deploymentProbe.attempts.at(-1);
      console.log(
        "Deployment-first search",
        condition,
        query.q,
        Math.round(probe.ms),
        "ms",
        "sequence",
        probe.result.telemetry.requestNumber,
        "R2",
        probe.result.diagnostics.requests,
      );
    }
} finally {
  await save();
  await run(
    [
      "wrangler",
      "delete",
      "--config",
      `work/columnar-deploy/${name}.json`,
      "--force",
    ],
    `work/columnar-bench/${label}-cleanup.log`,
  );
}
