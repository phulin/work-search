import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
const root = "work/full-flp";
await mkdir(root, { recursive: true });
const secretFile = root + "/secrets.json";
let secrets: { INTERNAL_TOKEN: string };
try {
  secrets = JSON.parse(await readFile(secretFile, "utf8"));
} catch {
  secrets = { INTERNAL_TOKEN: randomBytes(32).toString("hex") };
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
}
const wrangler = (args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { encoding: "utf8" },
  );
  if (r.status) throw Error(r.stdout + r.stderr);
  return r.stdout;
};
export async function deploy(
  name: string,
  main: string,
  vars: Record<string, string>,
  children: { binding: string; service: string }[] = [],
) {
  const config = resolve(root + "/" + name + ".json");
  await writeFile(
    config,
    JSON.stringify(
      {
        name,
        main: resolve(main),
        compatibility_date: "2026-11-01",
        account_id: "8f088d4bd190caf693cc42bb8311fd7d",
        workers_dev: true,
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
        r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
        services: children,
        vars,
        limits: { cpu_ms: 300000 },
      },
      null,
      2,
    ),
  );
  const output = wrangler(["deploy", "--config", config]);
  const hash = createHash("sha256")
    .update(secrets.INTERNAL_TOKEN)
    .digest("hex");
  const marker = config + ".secret-sha";
  const old = await readFile(marker, "utf8").catch(() => "");
  if (old !== hash) {
    wrangler(["secret", "bulk", resolve(secretFile), "--config", config]);
    await writeFile(marker, hash);
  }
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  console.log("Deployed", name, match?.[0] ?? "");
  return match?.[0];
}
if (process.argv.includes("--root")) {
  const url = await deploy("work-search-demo", "demo/gateway.ts", {
    ROLE: "root",
    CHILDREN: "[]",
  });
  await writeFile(root + "/deployment.json", JSON.stringify({ url }, null, 2));
}
