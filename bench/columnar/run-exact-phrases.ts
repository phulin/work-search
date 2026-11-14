/** Quiet randomized/interleaved local comparisons; do not run construction,
 * publication, profiling or tests concurrently with this process. */
import { spawn } from "node:child_process";
import { open, mkdir } from "node:fs/promises";
const index = process.env.CWS_EXACT_INDEX ?? "work/complete-context-v2-1m";
await mkdir("work/columnar-bench", { recursive: true });
const runs = [
  {
    label: "exact-phrases-empty",
    contract: "work/exact-phrases-contract.json",
    condition: "fresh-namespace",
    repeats: 5,
    primes: 1,
  },
  {
    label: "exact-phrases-shared",
    contract: "work/exact-phrases-contract.json",
    condition: "shared-warm-memory-empty",
    repeats: 5,
    primes: 3,
  },
  {
    label: "exact-phrases-reuse",
    contract: "work/exact-phrases-contract.json",
    condition: "memory-reuse",
    repeats: 5,
    primes: 1,
  },
  {
    label: "exact-phrases-200",
    contract: "work/io-iteration/expanded-contract.json",
    condition: "shared-warm-memory-empty",
    repeats: 2,
    primes: 3,
  },
  {
    label: "exact-phrases-independent",
    contract: "work/io-iteration/oracle-160.json",
    condition: "memory-reuse",
    repeats: 1,
    primes: 1,
    plans: "auto-N100-M1000",
  },
];
for (const r of runs) {
  if (process.env.CWS_EXACT_LABEL)
    r.label = r.label.replace("exact-phrases", process.env.CWS_EXACT_LABEL);
  console.log("Starting", r.label);
  const log = await open("work/" + r.label + ".log", "w");
  try {
    await new Promise<void>((yes, no) => {
      const p = spawn(
        "yarn",
        [
          "node",
          "--import",
          "tsx",
          "bench/columnar/simulate.ts",
          index,
          r.contract,
        ],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            CWS_CONTROL_SOURCE: "work/phrase-control",
            CWS_CONTROL_RUNTIME: "frozen",
            CWS_CONTROL_INDEX: "work/phrase-control-index",
            CWS_LOCAL_DATA: index,
            CWS_PAIR_INDEX: index,
            CWS_PLANS: r.plans ?? "control-N100-M1000,auto-N100-M1000",
            CWS_REPEATS: String(
              r.contract === "work/exact-phrases-contract.json"
                ? Number(process.env.CWS_REPRESENTATIVE_REPEATS ?? r.repeats)
                : r.repeats,
            ),
            CWS_PRIME_PASSES: String(r.primes),
            CWS_LABEL: r.label,
            CWS_ISOLATE_SCENARIOS: "1",
            CWS_CONDITION: r.condition,
          },
        },
      );
      p.once("error", no);
      p.once("exit", (c) =>
        c === 0 ? yes() : no(Error(r.label + " exited " + c)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Finished", r.label);
}
