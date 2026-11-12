import { readFile, writeFile, open } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
const root = "work/full-flp";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const find = (pattern: string) => {
  try {
    return (
      Number(
        execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
          .trim()
          .split("\n")[0],
      ) || 0
    );
  } catch {
    return 0;
  }
};
const finished = async (file: string) =>
  readFile(root + "/" + file, "utf8").then(
    () => true,
    () => false,
  );
const tasks = [
  {
    name: "opinions-import",
    pattern: "scripts/import-flp.py --decoder-threads 4$",
    args: [
      "scripts/import-flp.py",
      "--decoder-threads",
      "4",
      "--batch-docs",
      "100000",
      "--batch-mib",
      "1024",
    ],
    exe: "work/flp-venv/bin/python",
    done: "import-complete.json",
    log: "opinions-import.log",
    pid: 0,
    retries: 0,
  },
  {
    name: "indexing-pool",
    pattern: "scripts/full-flp-pool.ts$",
    args: ["--import", "tsx", "scripts/full-flp-pool.ts"],
    exe: process.execPath,
    done: "deployment-complete.json",
    log: "indexing-pool.log",
    pid: 0,
    retries: 0,
  },
  {
    name: "viewer-export",
    pattern: "scripts/backfill-viewer.py$",
    args: ["scripts/backfill-viewer.py"],
    exe: "work/flp-venv/bin/python",
    done: "viewer-backfill-complete.json",
    log: "viewer-backfill.log",
    pid: 0,
    retries: 0,
  },
  {
    name: "viewer-upload",
    pattern: "scripts/viewer-backfill-pool.ts$",
    args: ["--import", "tsx", "scripts/viewer-backfill-pool.ts"],
    exe: process.execPath,
    done: "viewer-publishing-complete.json",
    log: "viewer-publishing.log",
    pid: 0,
    retries: 0,
  },
];
for (const t of tasks) t.pid = find(t.pattern);
const caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
  stdio: "ignore",
});
for (;;) {
  let allDone = true;
  for (const t of tasks) {
    if (t.name === "viewer-upload") {
      const target = await readFile(root + "/viewer-targets.json", "utf8").then(
        JSON.parse,
        () => null,
      );
      if (target) {
        const { readdir } = await import("node:fs/promises");
        const done = (await readdir(root + "/viewer-jobs")).filter((n) =>
          n.endsWith(".processed"),
        ).length;
        if (done === target.length)
          await writeFile(
            root + "/" + t.done,
            JSON.stringify({ complete: true, partitions: done }),
          );
      }
    }
    if (await finished(t.done)) continue;
    allDone = false;
    if (t.pid && alive(t.pid)) continue;
    if (++t.retries > 5) {
      await writeFile(
        root + "/supervisor-needs-attention.json",
        JSON.stringify({ task: t.name, retries: t.retries }),
      );
      throw Error("Import requires attention: " + t.name);
    }
    const log = await open(root + "/" + t.log, "a");
    const child = spawn(t.exe, t.args, {
      env: {
        ...process.env,
        FLP_BUILDERS: t.retries > 1 ? "1" : "3",
        FLP_HEAP_MIB: t.retries > 1 ? "6144" : "3072",
      },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.on("error", (e) => console.error(t.name, e));
    t.pid = child.pid ?? 0;
    await log.close();
    console.log(
      "Restarted",
      t.name,
      t.pid,
      "attempt",
      t.retries,
      new Date().toISOString(),
    );
  }
  await writeFile(
    root + "/supervisor-status.json",
    JSON.stringify(
      tasks.map((t) => ({ task: t.name, pid: t.pid, retries: t.retries })),
      null,
      2,
    ),
  );
  if (allDone) {
    console.log("All import, deployment and reader jobs complete");
    break;
  }
  await new Promise((r) => setTimeout(r, 10000));
}
caffeinate.kill();
