import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { constructionLock } from "./construction-lock.js";

/** A durable local coordinator invokes one constructor Worker many times.
 * It changes no serving deployment. Court filtering writes pointer maps only;
 * existing immutable source content remains the construction input. */
const out = resolve(process.argv[2] ?? "work/court-cases-full"),
  build = process.argv[3] ?? "court-cases-full-20261115",
  name = process.env.CWS_CONSTRUCTOR_NAME ?? "work-search-cws-build-0",
  original = out + "/original-source-root.json",
  filtered = out + "/source/source-root.json";
await mkdir(out, { recursive: true });
await constructionLock(out + "/coordinator.lock");
const env = {
  ...process.env,
  CWS_BUILD_URL: `https://${name}.phulin.workers.dev`,
  CWS_BUILD_CONCURRENCY: process.env.CWS_BUILD_CONCURRENCY ?? "32",
};
let active: ReturnType<typeof spawn> | undefined;
async function progress(stage: string, details = {}) {
  await writeFile(
    out + "/run.json.tmp",
    JSON.stringify(
      {
        pid: process.pid,
        stage,
        build,
        constructor: name,
        updatedAt: new Date().toISOString(),
        ...details,
      },
      null,
      2,
    ),
  );
  await rename(out + "/run.json.tmp", out + "/run.json");
}
async function run(script: string, args: string[], extra = {}) {
  await new Promise<void>((ok, no) => {
    const child = spawn("yarn", ["node", "--import", "tsx", script, ...args], {
      env: { ...env, ...extra },
      stdio: "inherit",
    });
    active = child;
    child.once("error", no);
    child.once("exit", (code, signal) => {
      active = undefined;
      code === 0 ? ok() : no(Error(`${script} exited ${code ?? signal}`));
    });
  });
}
let checkingUsage = false;
async function usage() {
  if (checkingUsage) return;
  checkingUsage = true;
  try {
    await new Promise<void>((ok, no) => {
      const child = spawn(
        "yarn",
        [
          "node",
          "--import",
          "tsx",
          "scripts/cloudflare-usage.ts",
          "1",
          out + "/usage",
        ],
        { env, stdio: "inherit" },
      );
      child.once("error", no);
      child.once("exit", (c) =>
        c === 0 ? ok() : no(Error("Usage check failed " + c)),
      );
    });
  } catch (e) {
    console.error(String(e));
  } finally {
    checkingUsage = false;
  }
}
const interval = setInterval(() => {
  void usage();
}, 15 * 60000);
interval.unref();
const stop = () => {
  active?.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  await progress("preparing-source");
  await run("scripts/construction-source.ts", [
    "work/full-flp/published.json",
    original,
  ]);
  const available = JSON.parse(await readFile(original, "utf8")),
    imported = JSON.parse(
      await readFile("work/full-flp/import-complete.json", "utf8"),
    );
  if (!imported.complete || imported.documents !== available.documents)
    throw Error("Published source does not cover the complete imported corpus");
  await usage();
  await progress("filtering-court-cases", { available: available.documents });
  await run("scripts/deploy-construction.ts", [name], {
    CWS_SOURCE_ROOT: original,
  });
  await run("scripts/filter-court-source.ts", [original, out + "/source"]);
  const source = JSON.parse(await readFile(filtered, "utf8")),
    selection = JSON.parse(
      await readFile(out + "/source/complete.json", "utf8"),
    );
  await progress("deploying-filtered-constructor", {
    documents: source.documents,
    excluded: selection.excluded,
  });
  await run("scripts/deploy-construction.ts", [name], {
    CWS_SOURCE_ROOT: filtered,
  });
  await progress("building-index", {
    documents: source.documents,
    excluded: selection.excluded,
  });
  await run(
    "scripts/build-in-workers.ts",
    [String(source.documents), out + "/index", build],
    { CWS_SOURCE_ROOT: filtered },
  );
  await progress("base-index-complete", {
    documents: source.documents,
    generation: JSON.parse(await readFile(out + "/index/root.json", "utf8"))
      .generation,
    remaining:
      "Complete pair/context generation and full-corpus serving validation precede adoption; no public deployment.",
  });
  await usage();
} catch (e) {
  await progress("failed", { error: String(e) });
  throw e;
} finally {
  clearInterval(interval);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
