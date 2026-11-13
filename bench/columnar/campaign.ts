import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const progress: any[] = [];
async function run(
  label: string,
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  progress.push({
    label,
    startedAt: new Date().toISOString(),
    script,
    args,
    env,
  });
  await writeFile(
    "work/columnar-bench/campaign.json",
    JSON.stringify(progress, null, 2),
  );
  const code = await new Promise<number | null>((ok, no) => {
    const p = spawn("yarn", ["node", "--import", "tsx", script, ...args], {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.once("error", no);
    p.once("exit", ok);
  });
  progress.at(-1).exit = code;
  progress.at(-1).finishedAt = new Date().toISOString();
  await writeFile(
    "work/columnar-bench/campaign.json",
    JSON.stringify(progress, null, 2),
  );
  if (code !== 0) throw Error(label + " exited " + code);
}
while (
  !(await readFile(
    "work/columnar-deploy/work-search-cws-v2-manifest.json",
    "utf8",
  ).then(
    () => true,
    () => false,
  ))
)
  await new Promise((r) => setTimeout(r, 5000));
await run("v2-regression", "bench/columnar/with-tail.ts", [], {
  CWS_VARIANTS: "work-search-cws-control,work-search-cws-v2",
  CWS_LABEL: "pilot-v2",
  CWS_SESSIONS: "2",
});
await run("deploy-v3", "scripts/deploy-columnar.ts", [
  "work/columnar-100k-lanes",
  "work-search-cws-v3",
  "--deploy-only",
]);
await run("v3-expanded-pilot", "bench/columnar/with-tail.ts", [], {
  CWS_DRIVER: "bench/columnar/load.ts",
  CWS_VARIANTS: "work-search-cws-control,work-search-cws-v3",
  CWS_LABEL: "pilot-v3-expanded",
  CWS_SESSIONS: "2",
  CWS_REQUESTS: "200",
  CWS_RATE: "4",
  CWS_CONDITION: "shared-warm-memory-empty",
});
