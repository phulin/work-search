import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const [out, ...names] = process.argv.slice(2);
if (!out || !names.length) throw Error("Use OUTPUT.json.gz WORKER...");
const rows: unknown[] = [],
  children = names.map((name) => {
    const child = spawn(
      "yarn",
      [
        "wrangler",
        "tail",
        "--config",
        `work/columnar-worker-build/${name}.json`,
        "--format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let depth = 0,
      quoted = false,
      escaped = false,
      current = "";
    child.stdout.on("data", (bytes) => {
      for (const c of bytes.toString()) {
        if (!depth) {
          if (c !== "{") continue;
          current = "";
        }
        current += c;
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          try {
            const event = JSON.parse(current);
            let telemetry;
            for (const log of event.logs ?? [])
              for (const message of log.message ?? [])
                if (typeof message === "string" && message.startsWith("{")) {
                  try {
                    telemetry = JSON.parse(message).construction ?? telemetry;
                  } catch {}
                }
            if (event.event?.request?.url || telemetry)
              rows.push({
                name,
                path: event.event?.request?.url
                  ? new URL(event.event.request.url).pathname
                  : telemetry?.operation,
                invocation: event.event?.request ? "http" : "queue",
                cpuMs: event.cpuTime,
                wallMs: event.wallTime,
                outcome: event.outcome,
                timestamp: event.eventTimestamp,
                telemetry,
              });
          } catch {}
        }
      }
    });
    return child;
  });
await new Promise((r) => setTimeout(r, 60000));
for (const child of children) child.kill("SIGTERM");
await writeFile(
  out,
  gzipSync(
    JSON.stringify({
      kind: "Sampled native Cloudflare construction CPU and wall time; headers and source text excluded",
      rows,
    }),
  ),
);
console.log("Native construction observations", rows.length);
