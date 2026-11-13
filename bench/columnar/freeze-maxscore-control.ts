import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const revision = "b322b8b",
  out = "work/maxscore-control-b322b8b";
await mkdir(out, { recursive: true });
execFileSync("tar", ["-x", "-C", out], {
  input: execFileSync("git", ["archive", revision, "src"], {
    maxBuffer: 32 * 1048576,
  }),
});
const path = out + "/src/columnar/search.ts";
let source = await readFile(path, "utf8");
const before = createHash("sha256").update(source).digest("hex");
function replace(old: string, next: string) {
  if (source.split(old).length !== 2)
    throw Error("Control instrumentation anchor is not unique");
  source = source.replace(old, next);
}
replace("await reader.prefetch(refs);", "await reader.prefetchScores(refs);");
replace(
  "const data = await reader.many(\n        blocks.flatMap",
  "reader.stats.eagerScoreWindows++;\n      reader.stats.eagerScoreFetchWindows++;\n      const data = await reader.scores(\n        blocks.flatMap",
);
replace(
  "reader.stats.postings += batch.append(raw, j);",
  "const decoded = batch.append(raw, j);\n          reader.stats.postings += decoded;\n          reader.stats.scorePostingsDecoded += decoded;\n          reader.stats.scoreBlocksDecoded++;",
);
await writeFile(path, source);
await writeFile(
  out + "/instrumentation.json",
  JSON.stringify(
    {
      revision: execFileSync("git", ["rev-parse", revision], {
        encoding: "utf8",
      }).trim(),
      originalSearchSha256: before,
      instrumentedSearchSha256: createHash("sha256")
        .update(source)
        .digest("hex"),
      changes:
        "Counter-only annotations: same many()/prefetch() calls, same decode and execution order. Reader.scores defaults to many(), without coalescing.",
    },
    null,
    2,
  ),
);
console.log("Frozen control with symmetric score counters:", out);
