import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
const [input, output] = process.argv.slice(2);
if (!output) throw Error("Usage: report-cpu.ts INPUT OUTPUT");
interface CpuSession {
  name: string;
  kind: string;
  source: { version: string; [key: string]: unknown }[];
  rows: {
    q: string;
    version: string;
    resultSha256: string;
    wallMs: number;
  }[];
  batches: {
    q: string;
    version: string;
    n: number;
    cpuMs: number;
    meanCpuMs: number;
  }[];
}
const runs: CpuSession[] = [];
for (const name of (await readdir(input))
  .filter((n) => /^cpu-only.*-s[12]\.json\.gz$/.test(n))
  .sort()) {
  const run = JSON.parse(
    gunzipSync(await readFile(input + "/" + name)).toString(),
  );
  runs.push({ name, ...run });
}
if (
  runs.length !== 2 ||
  JSON.stringify(runs[0].source) !== JSON.stringify(runs[1].source)
)
  throw Error("Expected two sessions of identical implementations/generation");
const control = runs[0].source.find((s) => s.version !== ".")!.version,
  summaries = [];
for (const q of new Set(runs[0].rows.map((r) => r.q))) {
  const rows = runs.flatMap((r) => r.rows.filter((x) => x.q === q));
  if (new Set(rows.map((r) => r.resultSha256)).size !== 1)
    throw Error("Exact response mismatch: " + q);
  const variant = (version: string) => {
    const batches = runs.flatMap((r) =>
        r.batches.filter((b) => b.q === q && b.version === version),
      ),
      rs = rows.filter((r) => r.version === version),
      n = batches.reduce((n, b) => n + b.n, 0);
    if (batches.length !== 2 || rs.length !== n)
      throw Error("Incomplete CPU batch");
    return {
      version,
      n,
      meanCpuMs: batches.reduce((n, b) => n + b.cpuMs, 0) / n,
      sessionMeanCpuMs: batches.map((b) => b.meanCpuMs),
      meanWallMs: rs.reduce((n, r) => n + r.wallMs, 0) / n,
    };
  };
  const s = { q, control: variant(control), replacement: variant(".") };
  summaries.push(s);
  console.log(
    q,
    s.control.meanCpuMs.toFixed(2) +
      " -> " +
      s.replacement.meanCpuMs.toFixed(2),
  );
}
await mkdir(output, { recursive: true });
for (const r of runs)
  if (resolve(input) !== resolve(output))
    await copyFile(input + "/" + r.name, output + "/" + r.name);
await writeFile(
  output + "/cpu-summary.json",
  JSON.stringify(
    {
      kind: runs[0].kind,
      source: runs[0].source,
      notes:
        "Two isolated process pairs; batch CPU includes each version's own background GC, deferred cache work and IPC. Session ranges are descriptive, not confidence intervals or native Worker evidence.",
      summaries,
    },
    null,
    2,
  ) + "\n",
);
