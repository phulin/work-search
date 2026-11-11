import { writeFile } from "node:fs/promises";
const [base, ...queries] = process.argv.slice(2);
if (!base || !queries.length)
  throw new Error(
    "Usage: npx tsx bench/remote.ts https://worker.example query ...",
  );
const samples = [];
for (let i = 0; i < 10; i++)
  for (const q of queries) {
    const start = performance.now();
    const response = await fetch(
      new URL("/search?q=" + encodeURIComponent(q), base),
    );
    await response.arrayBuffer();
    samples.push({ q, status: response.status, ms: performance.now() - start });
  }
await writeFile(
  "bench/results/deployed.json",
  JSON.stringify(
    {
      base,
      measuredAt: new Date().toISOString(),
      kind: "deployed network latency from this machine",
      samples,
    },
    null,
    2,
  ),
);
