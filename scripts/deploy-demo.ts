import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
const wrangler = async (args: string[]) => {
  for (let attempt = 0; ; attempt++) {
    const r = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["node_modules/wrangler/bin/wrangler.js", ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    if (r.status === 0) return r.stdout;
    const message = (r.stdout ?? "") + (r.stderr ?? "");
    // Newly created Workers can briefly be absent from the subsequent API read.
    if (attempt >= 4 || !/code: 10007|\b50[234]\b|fetch failed/i.test(message))
      throw Error(message);
    console.log("Retrying transient deployment failure", args[0], attempt + 1);
    await new Promise((r) =>
      setTimeout(r, Math.min(16000, 2000 * 2 ** attempt)),
    );
  }
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
  const output = await wrangler(["deploy", "--config", config]);
  const hash = createHash("sha256")
    .update(secrets.INTERNAL_TOKEN)
    .digest("hex");
  const marker = config + ".secret-sha";
  const old = await readFile(marker, "utf8").catch(() => "");
  if (old !== hash) {
    await wrangler(["secret", "bulk", resolve(secretFile), "--config", config]);
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
