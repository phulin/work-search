import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const variants = (
    process.env.CWS_VARIANTS ?? "work-search-cws-control,work-search-cws-near"
  ).split(","),
  label = process.env.CWS_LABEL ?? "pilot",
  rows: unknown[] = [];
await mkdir("work/columnar-bench", { recursive: true });
const tails = variants.map((name) => {
  const config =
    name === "work-search-cws-control"
      ? "work/columnar-control/wrangler.json"
      : `work/columnar-deploy/${name}.json`;
  const child = spawn(
    "yarn",
    ["wrangler", "tail", "--config", config, "--format", "json"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let depth = 0,
    quoted = false,
    escaped = false,
    current = "",
    stderrBytes = 0;
  child.stderr.on("data", (b) => (stderrBytes += b.length));
  child.stdout.on("data", (b) => {
    for (const c of b.toString()) {
      if (!depth) {
        if (c !== "{") continue;
        current = "";
      }
      current += c;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v = JSON.parse(current),
            rawUrl = v.event?.request?.url;
          if (!rawUrl) continue;
          const url = new URL(rawUrl);
          const logs = v.logs ?? [];
          let telemetry;
          for (const log of logs)
            for (const message of log.message ?? [])
              if (typeof message === "string" && message.startsWith("{")) {
                try {
                  telemetry = JSON.parse(message).benchmark ?? telemetry;
                } catch {}
              }
          rows.push({
            name,
            requestId:
              telemetry?.requestId ?? url.searchParams.get("requestId"),
            q: url.searchParams.get("q"),
            cpuMs: v.cpuTime,
            wallMs: v.wallTime,
            outcome: v.outcome,
            telemetry,
            timestamp: v.eventTimestamp,
          });
        } catch {}
        current = "";
      }
    }
  });
  return { child, name, stderrBytes: () => stderrBytes };
});
try {
  await new Promise((r) => setTimeout(r, 10000));
  await new Promise<void>((ok, no) => {
    const p = spawn(
      "yarn",
      [
        "node",
        "--import",
        "tsx",
        process.env.CWS_DRIVER ?? "bench/columnar/live.ts",
      ],
      { stdio: "inherit", env: process.env },
    );
    p.once("error", no);
    p.once("exit", (c) => (c === 0 ? ok() : no(Error("Driver " + c))));
  });
  await new Promise((r) => setTimeout(r, 5000));
} finally {
  for (const t of tails) t.child.kill("SIGTERM");
  await writeFile(
    `work/columnar-bench/${label}-cpu.json.gz`,
    gzipSync(
      JSON.stringify({
        kind: "Sanitized Cloudflare live tail; sampled coverage; no request headers retained",
        rows,
        stderr: tails.map((t) => ({ name: t.name, bytes: t.stderrBytes() })),
      }),
    ),
  );
}
