import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const paths = process.argv.slice(2);
if (!paths.length)
  throw Error(
    "Usage: yarn node --import tsx bench/rust-builder/summarize.ts RESULTS.json [...]",
  );
const median = (a: number[]) =>
  [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const sessions = [];
for (const path of paths) {
  const raw = await readFile(path),
    results = JSON.parse(raw.toString());
  const groups = [];
  for (const count of new Set<number>(results.rows.map((r: any) => r.count))) {
    const variants = new Set<string>(
      results.rows
        .filter((r: any) => r.count === count)
        .map((r: any) => r.variant),
    );
    for (const variant of variants) {
      const rows = results.rows.filter(
        (r: any) => r.count === count && r.variant === variant,
      );
      const wall = rows.map((r: any) => r.wallMs);
      groups.push({
        count,
        variant,
        samples: rows.length,
        wallMs: {
          median: median(wall),
          min: Math.min(...wall),
          max: Math.max(...wall),
        },
        medianIndividualRssBytes: median(
          rows.map((r: any) => r.peakBuilderRssBytes),
        ),
        medianSampledTreeRssBytes: rows.every(
          (r: any) => r.sampledPeakTreeRssBytes,
        )
          ? median(rows.map((r: any) => r.sampledPeakTreeRssBytes))
          : null,
        outputBytes: rows[0].manifest.bytes,
        generation: rows[0].manifest.generation,
        corpusHash: rows[0].manifest.corpusHash,
      });
    }
  }
  sessions.push({
    path,
    sha256: createHash("sha256").update(raw).digest("hex"),
    groups,
  });
}
console.log(
  JSON.stringify(
    {
      kind: "Offline complete-build statistics; independent sessions; ranges describe observations, not confidence intervals; no serving latency conclusions",
      sessions,
    },
    null,
    2,
  ),
);
