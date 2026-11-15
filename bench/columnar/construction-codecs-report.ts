import { readFile, writeFile } from "node:fs/promises";

const [resultsPath, tailPath, out] = process.argv.slice(2);
if (!out) throw Error("Use RESULTS_JSON TAIL_JSONL OUTPUT_JSON");
const source = JSON.parse(await readFile(resultsPath, "utf8"));
// Wrangler prints pretty JSON objects, preceded/followed by Yarn messages.
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
const results = source.results.map((r: any) => {
  const events = r.rays.map((ray: string) => byRay.get(ray)).filter(Boolean);
  return {
    ...r,
    nativeSamples: events.length,
    nativeCpuMs: events.reduce((n: number, e: any) => n + e.cpuTime, 0),
    nativeWallMs: events.reduce((n: number, e: any) => n + e.wallTime, 0),
    outcomes: events.map((e: any) => e.outcome),
  };
});
const output = {
  ...source,
  results,
  limits: [
    "One request per configuration; timing differences require repetition before claiming an optimum.",
    "Inputs and concurrency are identical; GET count is constant because these configurations vary output layout, not the input read layout.",
    "Verification downloads are reported separately and do not contribute to merge elapsed time.",
    "Worker performance.now codec timers do not measure CPU reliably; nativeCpuMs comes from Cloudflare logs joined by CF-Ray.",
  ],
};
await writeFile(out, JSON.stringify(output, null, 2));
console.table(
  results.map((r: any) => ({
    codec: r.codec,
    blockKiB: r.blockBytes / 1024,
    objectMiB: r.containerBytes / 1048576,
    elapsedMs: Math.round(r.clientMs),
    cpuMs: r.nativeCpuMs,
    samples: r.nativeSamples,
    gets: r.operations.get,
    puts: r.operations.put,
    writtenMiB: +(r.writtenBytes / 1048576).toFixed(2),
  })),
);
