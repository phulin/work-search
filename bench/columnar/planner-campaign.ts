import { mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
const [index, pairs, contracts] = process.argv.slice(2);
if (!index || !pairs || !contracts)
  throw Error("Usage: planner-campaign.ts INDEX PAIRS CONTRACTS");
const prefix = process.env.CWS_CAMPAIGN ?? "planner-1m",
  repeats = Number(process.env.CWS_REPEATS ?? 5),
  sessions = Number(process.env.CWS_SESSIONS ?? 2);
await mkdir("work/columnar-bench", { recursive: true });
for (let session = 0; session < sessions; session++)
  for (const condition of [
    "memory-reuse",
    "shared-warm-memory-empty",
    "fresh-namespace",
  ]) {
    const label = `${prefix}-${condition}-s${session + 1}`,
      log = await open(`work/${label}.log`, "w");
    console.log("Starting", label, new Date().toISOString());
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "yarn",
          [
            "node",
            "--import",
            "tsx",
            "bench/columnar/simulate.ts",
            index,
            contracts,
          ],
          {
            env: {
              ...process.env,
              CWS_CONTROL_SOURCE:
                process.env.CWS_CONTROL_SOURCE ?? "work/pair-control-2d77fc0",
              CWS_PAIR_INDEX: pairs,
              CWS_PLANS: "control-N100-M1000,auto-N100-M1000",
              CWS_CONDITION: condition,
              CWS_SHARED_CACHE_MIB: "1024",
              CWS_LABEL: label,
              CWS_REPEATS: String(repeats),
              CWS_SEED: String(20261113 + session * 7919),
            },
            stdio: ["ignore", log.fd, log.fd],
          },
        );
        child.on("error", reject);
        child.on("close", (code) =>
          code ? reject(Error(`${label} failed: ${code}`)) : resolve(),
        );
      });
    } finally {
      await log.close();
    }
    console.log("Completed", label, new Date().toISOString());
  }
