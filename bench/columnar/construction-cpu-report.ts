import { readFile, writeFile } from "node:fs/promises";

const [directory, tailPath, out] = process.argv.slice(2);
if (!out) throw Error("Use BUILD_DIRECTORY TAIL_JSONL OUTPUT_JSON");
const raw = await readFile(tailPath, "utf8"),
  events: any[] = [];
let depth = 0,
  start = -1,
  quoted = false,
  escape = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (start < 0) {
    if (c === "{" && (i === 0 || raw[i - 1] === "\n")) {
      start = i;
      depth = 1;
    }
    continue;
  }
  if (quoted) {
    if (escape) escape = false;
    else if (c === "\\") escape = true;
    else if (c === '"') quoted = false;
  } else if (c === '"') quoted = true;
  else if (c === "{") depth++;
  else if (c === "}" && --depth === 0) {
    events.push(JSON.parse(raw.slice(start, i + 1)));
    start = -1;
  }
}
const byRay = new Map(
  events.map((e) => [e.event?.request?.headers?.["cf-ray"]?.split("-")[0], e]),
);
const requests = (await readFile(directory + "/requests.jsonl", "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((r) => JSON.parse(r));
const rows = requests.flatMap((r) => {
  const e = r.ray && byRay.get(r.ray);
  return e
    ? [
        {
          path: r.path,
          task: r.task,
          ray: r.ray,
          status: r.status,
          clientMs: r.clientMs,
          cpuMs: e.cpuTime,
          nativeWallMs: e.wallTime,
          outcome: e.outcome,
          isolate: r.telemetry?.isolate,
          io: r.telemetry?.io,
        },
      ]
    : [];
});
const paths = [...new Set<string>(rows.map((r) => r.path))];
const phases = paths.map((path) => {
  const selected = rows.filter((r) => r.path === path && r.status === 200),
    cpu = selected.map((r) => r.cpuMs).sort((a, b) => a - b);
  return {
    path,
    samples: selected.length,
    cpuMs: cpu.reduce((a, b) => a + b, 0),
    p50CpuMs: cpu[Math.ceil(cpu.length * 0.5) - 1],
    p95CpuMs: cpu[Math.ceil(cpu.length * 0.95) - 1],
    maxCpuMs: cpu.at(-1),
    nativeWallMs: selected.reduce((n, r) => n + r.nativeWallMs, 0),
  };
});
await writeFile(
  out,
  JSON.stringify(
    {
      directory,
      requests: requests.length,
      observations: rows.length,
      phases,
      rows,
      note: "Cloudflare observations joined by CF-Ray; these are CPU and wall time, not peak memory. Missing observations are not treated as zero CPU.",
    },
    null,
    2,
  ),
);
console.table(phases);
