import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const name = "work-search-global-demo",
  child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "tail",
      "--config",
      `work/global-publish/${name}/search.json`,
      "--format",
      "json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
let output = "",
  errors = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (errors += b));
try {
  await new Promise((r) => setTimeout(r, 15000));
  for (const q of [
    "court",
    "summary judgment",
    '"clear and convincing evidence"',
    "court",
  ]) {
    const r = await fetch(
      `https://${name}.phulin.workers.dev/search?q=${encodeURIComponent(q)}`,
    );
    if (!r.ok) throw Error("CPU probe failed " + r.status);
    await r.arrayBuffer();
  }
  await new Promise((r) => setTimeout(r, 5000));
} finally {
  child.kill("SIGTERM");
}
await new Promise<void>((r) => child.once("exit", () => r()));
const values: any[] = [];
let depth = 0,
  start = 0,
  quoted = false,
  escaped = false;
for (let i = 0; i < output.length; i++) {
  const c = output[i];
  if (quoted) {
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === '"') quoted = false;
    continue;
  }
  if (c === '"') quoted = true;
  else if (c === "{") {
    if (!depth) start = i;
    depth++;
  } else if (c === "}" && --depth === 0) {
    try {
      values.push(JSON.parse(output.slice(start, i + 1)));
    } catch {}
  }
}
const rows = values.map((v) => {
  const metrics: Record<string, unknown> = {};
  function visit(o: any, path: string) {
    if (!o || typeof o !== "object") return;
    for (const [k, value] of Object.entries(o)) {
      if (/cpu|wall|duration/i.test(k)) metrics[path + k] = value;
      else if (typeof value === "object" && k !== "headers")
        visit(value, path + k + ".");
    }
  }
  visit(v, "");
  return {
    outcome: v.outcome,
    metrics,
    q: new URL(v.event?.request?.url ?? "https://none").searchParams.get("q"),
  };
});
await writeFile(
  "work/global-bench/native-cpu.json",
  JSON.stringify({ rows, count: values.length, stderrBytes: errors.length }),
);
console.log(JSON.stringify(rows));
