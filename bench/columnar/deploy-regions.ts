import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";
const token = await benchmarkToken();
for (const [label, region] of [
  ["west", "aws:us-west-2"],
  ["eu", "aws:eu-central-1"],
]) {
  const config = resolve(`work/columnar-deploy/client-${label}.json`);
  await writeFile(
    config,
    JSON.stringify(
      {
        name: "work-search-cws-client-" + label,
        main: resolve("bench/columnar/regional-worker.ts"),
        account_id: "8f088d4bd190caf693cc42bb8311fd7d",
        compatibility_date: "2026-11-01",
        compatibility_flags: ["global_fetch_strictly_public"],
        workers_dev: true,
        placement: { region },
        limits: { cpu_ms: 300000 },
      },
      null,
      2,
    ),
  );
  for (const args of [
    ["deploy", "--config", config],
    ["secret", "put", "INTERNAL_TOKEN", "--config", config],
  ])
    await new Promise<void>((ok, no) => {
      const p = spawn("yarn", ["wrangler", ...args], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      p.stdin.end(args[0] === "secret" ? token : undefined);
      p.once("error", no);
      p.once("exit", (c) => (c === 0 ? ok() : no(Error("Deploy " + c))));
    });
}
