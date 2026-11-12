import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const [
  input,
  source,
  destination,
  countArg = "100000",
  repeatsArg = "3",
  names = "gzip,zstd-1",
] = process.argv.slice(2);
if (!input || !source || !destination)
  throw Error(
    "Usage: run.ts INPUT GENERATED_SOURCE OUT [COUNT] [REPEATS] [CODECS]",
  );
const out = resolve(destination),
  binary = resolve(source, "target/release/work-search-builder"),
  rows: any[] = [];
await mkdir(out);
const sha = async (p: string) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
const provenance = {
  kind: "Diagnostic complete builds; experimental non-gzip format must not be deployed as CWS1; sequential alternating order; uncontrolled filesystem caches and shared host load; timings include instrumentation when CODEC_PROFILE is set",
  runnerSha256: await sha("bench/rust-builder/codecs/run.ts"),
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  source: JSON.parse(
    await readFile(resolve(source, "experiment-source.json"), "utf8"),
  ),
  binarySha256: await sha(binary),
  libraries: Object.fromEntries(
    await Promise.all(
      ["zstd", "lz4", "brotlienc", "brotlidec"].map(async (n) => [
        n,
        await sha(`/opt/homebrew/lib/lib${n}.dylib`),
      ]),
    ),
  ),
  threads: 8,
  batchMiB: 16,
  profile: !!process.env.CODEC_PROFILE,
  fixtureSampleEvery: process.env.CODEC_FIXTURES ? 64 : null,
  node: process.version,
};
for (let round = 0; round < Number(repeatsArg); round++) {
  const variants = names.split(",");
  if (round % 2) variants.reverse();
  for (const codec of variants) {
    const dir = out + `/${countArg}-${round}-${codec}`;
    const start = performance.now();
    const child = spawn(
      "/usr/bin/time",
      [
        "-l",
        binary,
        "build",
        "--input",
        resolve(input),
        "--out",
        dir,
        "--max-docs",
        countArg,
        "--threads",
        "8",
        "--batch-mib",
        "16",
      ],
      {
        env: { ...process.env, BUILDER_TEXT_CODEC: codec },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const code = await new Promise<number | null>((ok, no) => {
      child.once("error", no);
      child.once("exit", ok);
    });
    const wallMs = performance.now() - start;
    await writeFile(dir + ".stdout.log", stdout);
    await writeFile(dir + ".stderr.log", stderr);
    if (code !== 0)
      throw Error(`Build ${codec} failed: ${stderr.slice(-2000)}`);
    const manifest = JSON.parse(await readFile(dir + "/manifest.json", "utf8"));
    const profile: Record<string, Record<string, number>> = {},
      workerMs: number[] = [];
    for (const run of await readdir(dir + "/staging"))
      if (run.startsWith("run-")) {
        const r = JSON.parse(
          await readFile(dir + "/staging/" + run + "/ingested.json", "utf8"),
        );
        workerMs.push(r.milliseconds);
        if (process.env.CODEC_PROFILE) {
          const p = JSON.parse(
            await readFile(
              dir + "/staging/" + run + "/codec-profile.json",
              "utf8",
            ),
          );
          for (const [group, values] of Object.entries(p))
            for (const [k, v] of Object.entries(
              values as Record<string, number>,
            )) {
              profile[group] ??= {};
              profile[group][k] = (profile[group][k] ?? 0) + v;
            }
        }
      }
    rows.push({
      codec,
      round,
      wallMs,
      manifest,
      profile,
      summedWorkerMs: workerMs.reduce((a, b) => a + b, 0),
      peakIndividualRssBytes: Number(
        stderr.match(/(\d+)\s+maximum resident set size/)?.[1],
      ),
      timeOutput: stderr
        .split("\n")
        .filter((s) => /user|maximum resident/.test(s)),
      out: dir,
    });
    await writeFile(
      out + "/results.json",
      JSON.stringify({ ...provenance, rows }, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        codec,
        round,
        wallMs,
        stages: manifest.stagesMs,
        profile,
      }),
    );
    if (
      !(process.env.CODEC_KEEP === codec && round === Number(repeatsArg) - 1) &&
      !process.env.CODEC_FIXTURES
    )
      for (const sub of ["packs", "staging"])
        await rm(dir + "/" + sub, { recursive: true, force: true });
  }
}
