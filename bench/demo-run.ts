import { spawn } from "node:child_process";
async function run(
  file: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  await new Promise<void>((resolve, reject) => {
    const python = file.endsWith(".py");
    const child = spawn(
      python ? "python3" : process.execPath,
      python
        ? [file, ...args]
        : ["--max-old-space-size=4096", "--import", "tsx", file, ...args],
      { stdio: "inherit", env: { ...process.env, ...env } },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(file + " exited " + code)),
    );
  });
}
if (process.argv.includes("--prepare")) {
  for (const file of [
    "demo-setup",
    "demo-capture",
    "demo-latency",
    "demo-load",
  ])
    await run(`bench/${file}.ts`);
  await run("bench/demo-local.ts", ["--hydrate"]);
  await run("bench/demo-pages.ts", ["--hydrate"]);
}
await run("bench/demo-local.ts", [], { DEMO_OUTPUT: "local-final" });
await run("bench/demo-local.ts", [], {
  DEMO_MODES: "empirical-repeated",
  DEMO_PHASES: "repeat",
  DEMO_OUTPUT: "local-repeated-final",
});
await run("bench/demo-pages.ts");
await run("bench/demo-report.py");
