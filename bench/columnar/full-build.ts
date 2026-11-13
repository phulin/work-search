import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { finished } from "node:stream/promises";
const [out = "work/columnar-full-native", maximum = "4294967295"] =
  process.argv.slice(2);
await mkdir(out, { recursive: true });
await promisify(execFile)("cargo", ["build", "--release", "--locked"], {
  maxBuffer: 2 * 1048576,
});
const env = {
  ...process.env,
  CWS_OFFLINE_STORE:
    process.env.CWS_OFFLINE_STORE ??
    "https://work-search-cws-upload.phulin.workers.dev",
  CWS_CORPUS_MANIFEST: out + "/corpus-manifest.json",
};
const source = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/columnar-corpus.ts", "-", maximum],
  { env, stdio: ["ignore", "pipe", "inherit"] },
);
const builder = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/build-columnar.ts", "-", out],
  { env, stdio: ["pipe", "inherit", "inherit"] },
);
source.stdout.pipe(builder.stdin);
const compressed = createGzip({ level: 1 }),
  saved = createWriteStream(out + "/corpus.jsonl.gz.tmp");
source.stdout.pipe(compressed).pipe(saved);
const savedDone = finished(saved);
savedDone.catch(() => stop());
source.stdout.on("error", () => builder.kill("SIGTERM"));
builder.stdin.on("error", () => source.kill("SIGTERM"));
const stop = () => {
  source.kill("SIGTERM");
  builder.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const status = await Promise.all(
    [source, builder].map(
      (child) =>
        new Promise<number | null>((ok, no) => {
          child.once("error", (e) => {
            stop();
            no(e);
          });
          child.once("exit", (code) => {
            if (code) stop();
            ok(code);
          });
        }),
    ),
  );
  if (status.some((code) => code !== 0))
    throw Error("Streaming corpus build failed " + status.join(","));
  await savedDone;
  await rename(out + "/corpus.jsonl.gz.tmp", out + "/corpus.jsonl.gz");
  const corpus = JSON.parse(
      await readFile(out + "/corpus-manifest.json", "utf8"),
    ),
    root = JSON.parse(await readFile(out + "/root.json", "utf8"));
  if (corpus.documents !== root.count || corpus.sha256 !== root.corpusHash)
    throw Error("Published root and source stream disagree");
  await writeFile(
    out + "/stream-completion.json",
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        documents: root.count,
        generation: root.generation,
        corpusHash: root.corpusHash,
      },
      null,
      2,
    ),
  );
  console.log("Complete streaming build", root.count, root.generation);
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
