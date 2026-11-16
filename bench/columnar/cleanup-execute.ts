import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";
const [directory, action] = process.argv.slice(2);
if (!directory || !["prepare", "execute"].includes(action))
  throw Error("Use PLAN_DIRECTORY prepare|execute");
const name = "work-search-cws-cleanup-20261115",
  url = `https://${name}.phulin.workers.dev`,
  keep: string[] = JSON.parse(
    await readFile(directory + "/protected.json", "utf8"),
  ),
  keys: string[] = JSON.parse(await readFile(directory + "/keys.json", "utf8")),
  token = await benchmarkToken(),
  config = resolve(directory + "/wrangler.json");
const protectedSet = new Set(keep);
if (keys.some((k) => protectedSet.has(k)))
  throw Error("Protected key in deletion plan");
if (action === "prepare") {
  const hashes = keep
    .map((k) => createHash("sha256").update(k).digest())
    .sort(Buffer.compare);
  await mkdir(directory, { recursive: true });
  await writeFile(directory + "/protected.bin", Buffer.concat(hashes));
  await writeFile(
    directory + "/entry.ts",
    "import hashes from './protected.bin';import {cleanupWorker} from '../../bench/columnar/cleanup-worker.js';export default cleanupWorker(new Uint8Array(hashes));",
  );
  await writeFile(
    config,
    JSON.stringify(
      {
        name,
        main: resolve(directory + "/entry.ts"),
        account_id: "8f088d4bd190caf693cc42bb8311fd7d",
        compatibility_date: "2026-11-01",
        workers_dev: true,
        r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
        limits: { cpu_ms: 30000 },
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      },
      null,
      2,
    ),
  );
  for (const [args, input] of [
    [["deploy", "--config", config], ""],
    [["secret", "put", "INTERNAL_TOKEN", "--config", config], token],
  ] as const) {
    await new Promise<void>((ok, no) => {
      const p = spawn("yarn", ["wrangler", ...args], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      p.stdin.end(input);
      p.once("error", no);
      p.once("exit", (c) => (c === 0 ? ok() : no(Error("Deployment " + c))));
    });
  }
} else {
  const done = new Set<number>(
    JSON.parse(
      await readFile(directory + "/progress.json", "utf8").catch(() => "[]"),
    ),
  );
  for (const line of (
    await readFile(directory + "/progress.jsonl", "utf8").catch(() => "")
  )
    .split("\n")
    .filter(Boolean))
    done.add(JSON.parse(line));
  let next = 0;
  const batches = Math.ceil(keys.length / 1000);
  await Promise.all(
    Array.from(
      { length: Number(process.env.CWS_CLEANUP_WORKERS ?? 4) },
      async () => {
        while (next < batches) {
          const i = next++;
          if (done.has(i)) continue;
          const batch = keys.slice(i * 1000, (i + 1) * 1000);
          for (let retry = 0; ; retry++) {
            try {
              const r = await fetch(url, {
                method: "POST",
                headers: { authorization: `Bearer ${token}` },
                body: JSON.stringify(batch),
                signal: AbortSignal.timeout(60000),
              });
              if (r.status === 409) throw Error("FATAL protected key rejected");
              if (!r.ok || ((await r.json()) as any).requested !== batch.length)
                throw Error("Deletion " + r.status);
              break;
            } catch (error) {
              if (String(error).includes("FATAL") || retry === 6) throw error;
              await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
            }
          }
          done.add(i);
          await appendFile(
            directory + "/progress.jsonl",
            JSON.stringify(i) + "\n",
          );
          if (done.size % 50 === 0)
            console.log(
              "Deletion batches acknowledged",
              done.size,
              "/",
              batches,
            );
        }
      },
    ),
  );
  await writeFile(
    directory + "/progress.json",
    JSON.stringify([...done].sort((a, b) => a - b)),
  );
  await writeFile(
    directory + "/completed.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        requestedKeys: keys.length,
        batches: done.size,
        protectedKeys: keep.length,
        note: "R2 deletion is idempotent; acknowledged keys include already absent objects. Byte estimates are not measured storage reclaimed.",
      },
      null,
      2,
    ),
  );
}
