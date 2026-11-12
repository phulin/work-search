import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
const jobs = [
  { label: "matrix-base", env: {} },
  {
    label: "matrix-heads",
    env: {
      GLOBAL_HEADS: "1",
      GLOBAL_BENCH_ONLY: "global",
      GLOBAL_BENCH_PAGES: "128",
    },
  },
  {
    label: "cache-heads",
    env: {
      GLOBAL_HEADS: "1",
      GLOBAL_BENCH_ONLY: "global",
      GLOBAL_BENCH_PAGES: "128",
      GLOBAL_BENCH_BUDGETS: "8",
      GLOBAL_BENCH_PHASES: "cold,repeat",
    },
  },
];
for (const job of jobs) {
  const log = await open(`work/global-bench/${job.label}.log`, "w");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "bench/global-local.ts"],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            GLOBAL_BENCH_PHASES: "novel",
            GLOBAL_BENCH_LABEL: job.label,
            ...job.env,
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error(job.label + " failed " + code)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Finished", job.label);
}
