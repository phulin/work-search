import { open, readFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";

/** Serialize coordinators for one checkpoint, including the early directory
 * pass and the later package pass. Remote construction still runs in parallel. */
export async function constructionLock(path: string) {
  for (;;) {
    try {
      const file = await open(path, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      process.once("exit", () => {
        try {
          unlinkSync(path);
        } catch {
          /* A stale lock is recoverable. */
        }
      });
      return;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        } catch (e: any) {
          if (e.code !== "ESRCH") throw e;
        }
      } else throw Error("Incomplete construction lock: " + path);
      await unlink(path).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }
}
