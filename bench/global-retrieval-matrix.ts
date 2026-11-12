import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { cpus, platform, arch, release, totalmem } from "node:os";
import { parallel } from "../src/storage/types.js";
if (!process.env.GLOBAL_PAIRS || !process.env.GLOBAL_FINE_DIR)
  throw Error(
    "Set GLOBAL_PAIRS and GLOBAL_FINE_DIR to complete immutable builds",
  );
await mkdir("work/global-bench", { recursive: true });
await mkdir("work/retrieval-bench", { recursive: true });
const budgets = (process.env.GLOBAL_BUDGETS ?? "8,16,32,48").split(","),
  label = process.env.GLOBAL_MATRIX_LABEL ?? "retrieval-round2",
  concurrency = Number(process.env.GLOBAL_MATRIX_CONCURRENCY ?? 1);
await writeFile(
  `work/retrieval-bench/${label}-host.json`,
  JSON.stringify({
    node: process.version,
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0].model,
    cpus: cpus().length,
    memoryBytes: totalmem(),
    concurrency,
    budgets,
    profiles: process.env.GLOBAL_PROFILES ?? "pairs,windows,planned,fine",
    started: new Date().toISOString(),
  }),
);
await parallel(budgets, concurrency, async (mib) => {
  const name = `${label}-${mib}`,
    log = await open(`work/retrieval-bench/${name}.log`, "w");
  try {
    await new Promise<void>((ok, no) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "bench/global-retrieval.ts"],
        {
          env: {
            ...process.env,
            GLOBAL_PROFILES:
              process.env.GLOBAL_PROFILES ?? "pairs,windows,planned,fine",
            GLOBAL_BUNDLE: `work/global-100k/bundle-heads-${mib}.bin`,
            GLOBAL_BUDGET: mib,
            GLOBAL_PAIR_INTERSECT: "1",
            GLOBAL_ADAPTIVE_PROBE: "fused",
            GLOBAL_COMPETITIVE_LABEL: name,
          },
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      child.once("error", no);
      child.once("exit", (code) =>
        code === 0 ? ok() : no(Error(name + " exited " + code)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Completed", name);
});
