import { readFile, writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const dir = process.argv[2];
if (!dir) throw Error("Usage: cleanup-staging.ts BUILD_DIR");
const url =
    process.env.CWS_OFFLINE_STORE ??
    "https://work-search-cws-upload.phulin.workers.dev",
  token = await benchmarkToken();
const entries = [
  ...new Map(
    (await readFile(dir + "/remote-objects.jsonl", "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => !r.artifact)
      .map((r) => [r.key, r]),
  ).values(),
] as { key: string; sha256: string; size: number }[];
let next = 0,
  deleted = 0,
  bytes = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const entry = entries[next++];
      if (!entry) break;
      if (
        !/^[a-f0-9]{64}\/stage-[a-f0-9]{64}\.bin$/.test(entry.key) ||
        entry.key.split("/")[0] !== entry.sha256
      )
        throw Error("Invalid temporary artifact ledger");
      let ok = false;
      for (let retry = 0; retry < 5; retry++) {
        try {
          const r = await fetch(`${url}/${entry.key}`, {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${token}`,
              "x-sha256": entry.sha256,
            },
            signal: AbortSignal.timeout(60000),
          });
          if (!r.ok) throw Error("Temporary delete " + r.status);
          ok = true;
          break;
        } catch (e) {
          if (retry === 4) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** retry));
        }
      }
      if (ok) {
        deleted++;
        bytes += entry.size;
      }
    }
  }),
);
await writeFile(
  dir + "/staging-cleanup.json",
  JSON.stringify({ at: new Date().toISOString(), deleted, bytes }, null, 2),
);
console.log({ deleted, bytes });
