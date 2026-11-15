/** Local 1M only. Cold cache comparisons; no deployment, download or upload. */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, symlink, open } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
const index = "work/complete-context-v2-1m",
  control = "work/cold-packets-control",
  revision = execFileSync("git", ["rev-parse", "51ba38f"], {
    encoding: "utf8",
  }).trim();
await mkdir(control + "/index", { recursive: true });
const saved = await readFile(control + "/commit", "utf8").catch((e) => {
  if (e.code !== "ENOENT") throw e;
  return undefined;
});
if (
  saved &&
  execFileSync("git", ["rev-parse", saved.trim()], {
    encoding: "utf8",
  }).trim() !== revision
)
  throw Error("Different frozen control");
if (!saved) {
  execFileSync("tar", ["-x", "-C", control], {
    input: execFileSync(
      "git",
      ["archive", revision, "src", "bench/columnar/local-storage.ts"],
      { maxBuffer: 64 * 1048576 },
    ),
  });
  await writeFile(control + "/commit", revision + "\n");
}
for (const name of ["root.json", "directory.bin", "documents.bin", "pairs"])
  await symlink(
    resolve(name === "pairs" ? index : index + "/" + name),
    control + "/index/" + name,
  ).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
const evidence = "bench/results/columnar/phrase-planner-1m";
for (const [source, target] of [
  ["expanded-200-contract", "work/io-iteration/expanded-contract.json"],
  ["independent-160-contract", "work/io-iteration/oracle-160.json"],
  ["focused-contract", "work/phrase-planner-contract.json"],
]) {
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(
    target,
    gunzipSync(await readFile(evidence + "/" + source + ".json.gz")),
  );
}
await mkdir("work/cold-followup", { recursive: true });
await writeFile(
  "work/cold-followup/heldout-contract.json",
  gunzipSync(
    await readFile(
      "bench/results/columnar/cold-followup-1m/heldout-contract.json.gz",
    ),
  ),
);
for (const [label, contract, repeats, noDelay, comparison] of [
  ["final-200", "work/io-iteration/expanded-contract.json", 3, false, true],
  ["heldout-32", "work/cold-followup/heldout-contract.json", 3, false, true],
  ["independent-160", "work/io-iteration/oracle-160.json", 1, true, false],
  ["focused-29", "work/phrase-planner-contract.json", 1, true, false],
] as const) {
  if (process.env.CWS_RUN_FILTER && !label.includes(process.env.CWS_RUN_FILTER))
    continue;
  const parsed = JSON.parse(await readFile(contract, "utf8"));
  if (
    !noDelay &&
    parsed.scenarios.some((s: any) => s.options?.exactTotal !== false)
  )
    throw Error("Performance requires exact totals off");
  const name = "cold-followup-" + label,
    log = await open("work/" + name + ".log", "w");
  console.log("Starting", name);
  try {
    await new Promise<void>((ok, no) => {
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
            CWS_CONTROL_SOURCE: control,
            CWS_CONTROL_RUNTIME: "frozen",
            CWS_CONTROL_INDEX: control + "/index",
            CWS_LOCAL_DATA: index,
            CWS_PAIR_INDEX: index,
            CWS_PLANS: comparison
              ? "control-N100-M1000,auto-N100-M1000"
              : "auto-N100-M1000",
            CWS_REPEATS: String(repeats),
            CWS_LABEL: name,
            CWS_ISOLATE_SCENARIOS: "1",
            CWS_CONDITION: "fresh-namespace",
            CWS_PRIME_PASSES: "1",
            CWS_NO_DELAY: noDelay ? "1" : "0",
          },
        },
      );
      child.once("error", no);
      child.once("exit", (code) =>
        code === 0 ? ok() : no(Error(name + " failed " + code)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Completed", name);
}
