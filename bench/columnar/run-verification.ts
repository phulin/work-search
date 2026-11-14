/** Sequential, quiet simulations; do not run tests/builds alongside this. */
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
const [
  index = "work/verification-1m",
  contract = "work/io-iteration/contract.json",
] = process.argv.slice(2);
const variants = [
  {
    label: "verification-measured-empty",
    condition: "fresh-namespace",
    passes: 1,
    repeats: 5,
  },
  {
    label: "verification-measured-reuse",
    condition: "memory-reuse",
    passes: 1,
    repeats: 7,
  },
  {
    label: "verification-measured-shared",
    condition: "shared-warm-memory-empty",
    passes: 3,
    repeats: 5,
  },
];
for (const v of variants) {
  console.log("Starting", v.label);
  const log = await open("work/" + v.label + ".log", "w");
  try {
    await new Promise<void>((yes, no) => {
      const child = spawn(
        "yarn",
        [
          "node",
          "--import",
          "tsx",
          "bench/columnar/simulate.ts",
          index,
          contract,
        ],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            CWS_CONTROL_SOURCE: "work/verification-control",
            CWS_CONTROL_RUNTIME: "frozen",
            CWS_CONTROL_INDEX: "work/verification-control-index",
            CWS_LOCAL_DATA: index,
            CWS_PAIR_INDEX: index,
            CWS_PLANS: "control-N100-M1000,auto-N100-M1000",
            CWS_REPEATS: String(v.repeats),
            CWS_LABEL: v.label,
            CWS_ISOLATE_SCENARIOS: "1",
            CWS_CONDITION: v.condition,
            CWS_PRIME_PASSES: String(v.passes),
          },
        },
      );
      child.once("error", no);
      child.once("exit", (code) =>
        code === 0 ? yes() : no(Error(v.label + " exit " + code)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Finished", v.label);
}
