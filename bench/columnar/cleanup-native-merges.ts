import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { benchmarkToken } from "./token.js";
type Ref = { key: string; sha256: string; size: number };
const [dir, last] = process.argv.slice(2),
  level = Number(last);
if (!dir || !Number.isInteger(level) || level < 0)
  throw Error("Use BUILD_DIRECTORY LAST_OBSOLETE_MERGE_LEVEL [--execute]");
const bytes = await readFile(dir + "/build.json"),
  state = JSON.parse(bytes.toString());
if (
  state.format !== "parallel-build-v2" ||
  !state.merges[level + 1]?.length ||
  !state.merges
    .slice(0, level + 2)
    .every((jobs: any[]) => jobs.every((j) => j.done))
)
  throw Error("The successor merge level must be completely acknowledged");
function refs(value: any, found = new Map<string, Ref>()) {
  if (!value || typeof value !== "object") return found;
  if (
    typeof value.key === "string" &&
    typeof value.sha256 === "string" &&
    Number.isSafeInteger(value.size)
  )
    found.set(value.key, value);
  for (const child of Object.values(value))
    if (child && typeof child === "object") refs(child, found);
  return found;
}
const obsolete = refs([state.ingests, ...state.merges.slice(0, level + 1)]),
  keep = refs({ ...state, ingests: [], merges: state.merges.slice(level + 1) });
// A content-addressed stream may also be reused by another local construction.
// Preserve every reference in other saved builds, including completed controls.
for (const entry of await readdir("work", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const suffix of ["/build.json", "/packets/build.json"]) {
    const file = "work/" + entry.name + suffix;
    if (resolve(file) === resolve(dir + "/build.json")) continue;
    const text = await readFile(file, "utf8").catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      },
    );
    if (text) refs(JSON.parse(text), keep);
  }
}
const selected = [...obsolete.values()].filter(
    (r) =>
      !keep.has(r.key) &&
      /^[a-f0-9]{64}$/.test(r.sha256) &&
      r.key === `${r.sha256}/stage-${r.sha256}.bin`,
  ),
  plan = {
    at: new Date().toISOString(),
    build: state.build,
    throughLevel: level,
    checkpointSha256: createHash("sha256").update(bytes).digest("hex"),
    successorJobs: state.merges[level + 1].length,
    objects: selected.length,
    bytes: selected.reduce((n, r) => n + r.size, 0),
    protectedReferences: keep.size,
    keysSha256: createHash("sha256")
      .update(selected.map((r) => r.key).join("\n"))
      .digest("hex"),
  };
console.log(plan);
await writeFile(
  dir + `/cleanup-through-${level}.json`,
  JSON.stringify(plan, null, 2),
);
if (process.argv.includes("--execute")) {
  const token = await benchmarkToken(),
    url = "https://work-search-cws-upload.phulin.workers.dev/__delete-staging";
  for (let i = 0; i < selected.length; i += 1000) {
    const keys = selected.slice(i, i + 1000).map((r) => r.key);
    for (let retry = 0; ; retry++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(keys),
          signal: AbortSignal.timeout(60000),
        });
        if (
          !response.ok ||
          ((await response.json()) as any).deleted !== keys.length
        )
          throw Error("Temporary deletion " + response.status);
        break;
      } catch (error) {
        if (retry === 6) throw error;
        await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
      }
    }
    await writeFile(
      dir + `/cleanup-through-${level}-progress.json`,
      JSON.stringify({
        ...plan,
        deleted: Math.min(i + 1000, selected.length),
        updatedAt: new Date().toISOString(),
      }),
    );
    if (i % 25000 === 0)
      console.log(
        "Deleted temporary streams",
        Math.min(i + 1000, selected.length),
        "/",
        selected.length,
      );
  }
}
