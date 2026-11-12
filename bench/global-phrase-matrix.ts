import { mkdir, open, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const pairs = process.env.GLOBAL_PAIRS;
if (!pairs)
  throw Error("GLOBAL_PAIRS must identify a complete immutable sidecar");
const storageMiB =
  JSON.parse(await readFile(pairs + "/manifest.json", "utf8")).budgetBytes /
  1048576;
await mkdir("work/phrase-experiments", { recursive: true });
for (const latency of [true, false])
  for (const mib of (process.env.GLOBAL_BUDGETS ?? "8,16,32,48").split(",")) {
    const label = `${process.env.GLOBAL_MATRIX_LABEL ?? `phrase${storageMiB}`}-${mib}-${latency ? "empirical" : "local"}`;
    const log = await open(`work/phrase-experiments/${label}.log`, "w");
    console.log("Starting", label);
    try {
      await new Promise<void>((done, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "bench/global-phrases.ts"],
          {
            env: {
              ...process.env,
              GLOBAL_BUDGET: mib,
              GLOBAL_BUNDLE: `work/global-100k/bundle-heads-${mib}.bin`,
              GLOBAL_NO_LATENCY: latency ? "0" : "1",
              GLOBAL_COMPETITIVE_LABEL: label,
            },
            stdio: ["ignore", log.fd, log.fd],
          },
        );
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? done() : reject(Error(label + " exited " + code)),
        );
      });
    } finally {
      await log.close();
    }
    console.log("Completed", label);
  }
