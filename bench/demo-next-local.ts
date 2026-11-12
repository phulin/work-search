import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
for (const level of [3, 4, 5]) {
  const log = await open(`work/demo-bench/next-stage${level}.log`, "w");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "bench/demo-local.ts"],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            DEMO_OPT_STAGE: String(level),
            DEMO_MODES: "empirical-repeated,empirical",
            DEMO_PHASES: "reset,repeat",
            DEMO_REPEATS: "3",
            DEMO_OUTPUT: `next-stage${level}`,
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Stage " + level + " failed")),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Completed local stage", level);
}
