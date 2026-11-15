/** Local simulation only. Run without other profiling, tests or construction. */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, open, readFile, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const index = "work/complete-context-v2-1m";
await mkdir("work/columnar-bench", { recursive: true });
const control = "work/phrase-planner-control",
  revision = "4850a4a1699ec93728b25c76ed69bb463e455ac3";
const recorded = await readFile(control + "/commit", "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return undefined;
});
if (recorded && recorded.trim() !== revision)
  throw Error("Different frozen control");
if (!recorded) {
  await mkdir(control, { recursive: true });
  execFileSync("tar", ["-x", "-C", control], {
    input: execFileSync(
      "git",
      ["archive", revision, "src", "bench/columnar/local-storage.ts"],
      { maxBuffer: 64 * 1048576 },
    ),
  });
  await writeFile(control + "/commit", revision + "\n");
}
await mkdir(control + "/index", { recursive: true });
for (const name of ["root.json", "directory.bin", "documents.bin", "pairs"]) {
  await symlink(
    resolve(name === "pairs" ? index : index + "/" + name),
    control + "/index/" + name,
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}
const evidence = "bench/results/columnar/phrase-planner-1m";
for (const [source, target] of [
  ["focused-contract", "work/phrase-planner-contract.json"],
  ["expanded-200-contract", "work/io-iteration/expanded-contract.json"],
  ["independent-160-contract", "work/io-iteration/oracle-160.json"],
]) {
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(
    target,
    gunzipSync(await readFile(evidence + "/" + source + ".json.gz")),
  );
  if (source === "expanded-200-contract") {
    const c = JSON.parse(await readFile(target, "utf8"));
    if (
      c.scenarios.length !== 200 ||
      c.scenarios.some((s: any) => s.options?.exactTotal !== false)
    )
      throw Error(
        "The 200-query benchmark requires exactTotal:false for every query",
      );
  }
}
const runs = [
  [
    "wide-empty",
    "work/io-iteration/expanded-contract.json",
    "fresh-namespace",
    3,
    1,
  ],
  [
    "focused-empty",
    "work/phrase-planner-contract.json",
    "fresh-namespace",
    3,
    1,
  ],
  [
    "focused-shared",
    "work/phrase-planner-contract.json",
    "shared-warm-memory-empty",
    3,
    3,
  ],
  ["focused-reuse", "work/phrase-planner-contract.json", "memory-reuse", 3, 1],
  [
    "wide-shared",
    "work/io-iteration/expanded-contract.json",
    "shared-warm-memory-empty",
    1,
    3,
  ],
  ["independent", "work/io-iteration/oracle-160.json", "memory-reuse", 1, 1],
] as const;
for (const [name, contract, condition, repeats, primes] of runs) {
  if (
    process.env.CWS_RUN_FILTER &&
    !process.env.CWS_RUN_FILTER.split(",").some((part) => name.includes(part))
  )
    continue;
  const label = "phrase-planner-" + name;
  console.log("Starting", label);
  const log = await open("work/" + label + ".log", "w");
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
          contract,
        ],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            CWS_CONTROL_SOURCE: "work/phrase-planner-control",
            CWS_CONTROL_RUNTIME: "frozen",
            CWS_CONTROL_INDEX: "work/phrase-planner-control/index",
            CWS_LOCAL_DATA: index,
            CWS_PAIR_INDEX: index,
            CWS_PLANS:
              name === "independent"
                ? "auto-N100-M1000"
                : "control-N100-M1000,auto-N100-M1000",
            CWS_REPEATS: String(repeats),
            CWS_PRIME_PASSES: String(primes),
            CWS_LABEL: label,
            CWS_ISOLATE_SCENARIOS: "1",
            CWS_CONDITION: condition,
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error(label + " exited " + code)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Finished", label);
}
