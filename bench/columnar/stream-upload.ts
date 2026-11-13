// Bound local output disk independently of corpus size. Only task-owned closed
// pack files are removed, and only after verified immutable R2 publication.
import { readFile, readdir, stat, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { request, Agent } from "node:https";
import { benchmarkToken } from "./token.js";
const [dir, pid, corpusManifest] = process.argv.slice(2);
if (!dir?.startsWith("work/columnar-") || !/^\d+$/.test(pid ?? ""))
  throw Error(
    "Usage: stream-upload TASK_INDEX_DIR BUILDER_PID CORPUS_MANIFEST",
  );
const corpus = JSON.parse(await readFile(corpusManifest, "utf8")),
  corpusHash = corpus.canonicalUncompressedSha256 ?? corpus.sha256,
  generation = createHash("sha256")
    .update(`CWS1:128:256:64:lanes\n${corpusHash}`)
    .digest("hex"),
  token = await benchmarkToken(),
  agent = new Agent({ keepAlive: true, maxSockets: 2 }),
  url = "https://work-search-cws-upload.phulin.workers.dev",
  published: Record<string, { size: number; sha256: string }> = {};
async function head(address: string) {
  return new Promise<{ status: number; sha: string; size: number }>(
    (ok, no) => {
      const r = request(
        address,
        {
          method: "HEAD",
          agent,
          headers: { authorization: `Bearer ${token}` },
        },
        (r) => {
          r.resume();
          r.once("end", () =>
            ok({
              status: r.statusCode ?? 0,
              sha: String(r.headers["x-sha256"] ?? ""),
              size: Number(r.headers["content-length"]),
            }),
          );
        },
      );
      r.once("error", no);
      r.setTimeout(120000, () => r.destroy(Error("HEAD timeout")));
      r.end();
    },
  );
}
let done = false;
try {
  for (;;) {
    const root = await readFile(dir + "/root.json", "utf8").then(
      JSON.parse,
      () => undefined,
    );
    if (root && root.generation !== generation)
      throw Error("Canonical corpus hash mismatch");
    const open =
        spawnSync("lsof", ["-a", "-p", pid, "-Fn"], { encoding: "utf8" })
          .stdout ?? "",
      builderAlive = open.length > 0;
    const files = (await readdir(dir + "/packs"))
      .filter((n) => /^plan-\d+\.bin$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    let next = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        for (;;) {
          const name = files[next++];
          if (!name) break;
          const path = resolve(dir + "/packs/" + name),
            s = await stat(path).catch(() => undefined);
          if (
            !s ||
            Date.now() - s.mtimeMs < 2000 ||
            open.includes("n" + path + "\n")
          )
            continue;
          const b = await readFile(path),
            sha = createHash("sha256").update(b).digest("hex"),
            expected = root?.objects[Number(name.match(/\d+/)![0])];
          if (
            expected &&
            (expected.sha256 !== sha || expected.size !== b.length)
          )
            throw Error("Closed pack mismatch");
          const address = `${url}/${generation}/${name}`;
          for (let attempt = 0; ; attempt++) {
            try {
              let h = await head(address);
              if (h.status !== 200) {
                if (h.status !== 404) throw Error("HEAD " + h.status);
                const compressed = gzipSync(b, { level: 1 }),
                  r = await fetch(address, {
                    method: "PUT",
                    headers: {
                      authorization: `Bearer ${token}`,
                      "x-sha256": sha,
                      "x-raw-length": String(b.length),
                    },
                    body: compressed,
                    signal: AbortSignal.timeout(180000),
                  });
                if (!r.ok)
                  throw Error("PUT " + r.status + ": " + (await r.text()));
                await r.arrayBuffer();
                h = await head(address);
              }
              if (h.status !== 200 || h.sha !== sha || h.size !== b.length)
                throw Error("Immutable R2 verification mismatch");
              break;
            } catch (e) {
              if (attempt === 4) throw e;
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
          published[name] = { size: b.length, sha256: sha };
          await writeFile(
            dir + "/stream-publication.json",
            JSON.stringify({ generation, corpusHash, published }, null, 2),
          );
          await unlink(path);
          console.log("Published and reclaimed", name, b.length);
        }
      }),
    );
    if (root && !files.length) {
      done = true;
      break;
    }
    if (!builderAlive && !root)
      throw Error("Builder stopped before publishing a root");
    await new Promise((r) => setTimeout(r, 2000));
  }
} finally {
  agent.destroy();
  if (!done)
    console.log(
      "Publication stopped; verified remote objects remain immutable.",
    );
}
