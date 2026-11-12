import { spawn } from "node:child_process";
async function run(args: string[], env: NodeJS.ProcessEnv = {}, quiet = false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      env: { ...process.env, ...env },
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.on("exit", (c) =>
      c === 0 ? resolve() : reject(Error(`Exit ${c}: ${args.join(" ")}`)),
    );
    child.on("error", reject);
  });
}
for (const stage of [2, 6])
  for (const budget of [16, 32, 48]) {
    await run(
      ["bench/build-paged-opts.ts", String(stage), String(budget)],
      {},
      true,
    );
    await run(["bench/paged.ts"], {
      PAGED_DESIGNS: `opt${stage}-${budget}`,
      PAGED_PREFIX: "paged-opts-budget",
      PAGED_DELAYS: "20",
      PAGED_COMPETITIVE: "false",
    });
  }
