import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const revision = process.argv[2] ?? "3572902",
  out = "work/cpu-control-" + revision;
await mkdir(out, { recursive: true });
execFileSync("tar", ["-x", "-C", out], {
  input: execFileSync("git", ["archive", revision, "src"], {
    maxBuffer: 32 * 1048576,
  }),
});
await writeFile(
  out + "/control.json",
  JSON.stringify(
    {
      revision: execFileSync("git", ["rev-parse", revision], {
        encoding: "utf8",
      }).trim(),
      searchSha256: createHash("sha256")
        .update(await readFile(out + "/src/columnar/search.ts"))
        .digest("hex"),
      changes:
        "None. Reader, caches, directory and executor all use the frozen source.",
    },
    null,
    2,
  ),
);
console.log(out);
