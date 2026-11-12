import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { resolve } from "node:path";
const [
  input,
  destination = "work/rust-builder-bench",
  countArg = "10000",
  repeatsArg = "3",
  threadsArg = "4",
  batchArg = "4",
] = process.argv.slice(2);
if (!input)
  throw Error(
    "Usage: yarn node --import tsx bench/rust-builder/benchmark.ts INPUT OUT [COUNTS_COMMA] [REPEATS] [THREADS] [BATCH_MIB]",
  );
const counts = countArg.split(",").map(Number),
  repeats = Number(repeatsArg),
  threads = Number(threadsArg),
  batchMiB = Number(batchArg),
  root = resolve(destination);
await mkdir(root, { recursive: true });
const sourceFiles = [
  "target/release/work-search-builder",
  "Cargo.lock",
  "crates/index-builder/src/main.rs",
  "crates/index-builder/src/ingest.rs",
  "crates/index-builder/src/format.rs",
  "crates/index-builder/src/merge.rs",
  "crates/index-builder/src/finalize.rs",
  "crates/index-builder/src/publish.rs",
  "crates/index-builder/src/tokenize.rs",
  "crates/index-builder/src/util.rs",
  "crates/index-builder/Cargo.toml",
  "crates/index-builder/build.rs",
  "crates/index-builder/unicode-tables.mjs",
  "Cargo.toml",
  "bench/rust-builder/benchmark.ts",
  "bench/rust-builder/control/build.ts",
  "bench/rust-builder/control/format.ts",
];
const hashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (p) => [
      p,
      createHash("sha256")
        .update(await readFile(p))
        .digest("hex"),
    ]),
  ),
);
const variants = (process.env.BUILDER_VARIANTS ?? "typescript,rust").split(",");
if (
  variants.some(
    (v) => !["typescript", "rust", "rust-v1", "rust-v2"].includes(v),
  )
)
  throw Error("Unknown builder variant");
const control = resolve(
  process.env.RUST_V1_CONTROL ?? "work/rust-builder-v1-control",
);
if (variants.includes("rust-v1"))
  for (const p of [
    "work-search-builder",
    "Cargo.lock",
    "index-builder/score-v8.mjs",
  ])
    hashes["rust-v1/" + p] = createHash("sha256")
      .update(await readFile(control + "/" + p))
      .digest("hex");
const controlV2 = resolve(
  process.env.RUST_V2_CONTROL ?? "work/rust-builder-v2-control",
);
if (variants.includes("rust-v2"))
  for (const p of ["work-search-builder", "Cargo.lock"])
    hashes["rust-v2/" + p] = createHash("sha256")
      .update(await readFile(controlV2 + "/" + p))
      .digest("hex");
const rows: any[] = [];
for (const count of counts)
  for (let round = 0; round < repeats; round++) {
    // Deterministic interleaving, different order in successive sessions.
    for (const variant of round % 2 ? [...variants].reverse() : variants) {
      const out = root + `/${count}-${round}-${variant}`;
      const args = variant.startsWith("rust")
        ? [
            variant === "rust-v1"
              ? control + "/work-search-builder"
              : variant === "rust-v2"
                ? controlV2 + "/work-search-builder"
                : "target/release/work-search-builder",
            "build",
            "--input",
            resolve(input),
            "--out",
            out,
            "--max-docs",
            String(count),
            "--threads",
            String(threads),
            "--batch-mib",
            String(batchMiB),
            ...(variant === "rust-v1"
              ? ["--scorer-script", control + "/index-builder/score-v8.mjs"]
              : []),
          ]
        : [
            process.execPath,
            "--import",
            "tsx",
            "bench/rust-builder/control/run.ts",
            resolve(input),
            out,
            String(count),
          ];
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const child = spawn(
        "/usr/bin/time",
        platform() === "darwin" ? ["-l", ...args] : ["-v", ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let sampledPeakTreeRssBytes = 0,
        sampling = false;
      const timer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        execFile(
          "ps",
          ["-axo", "pid=,ppid=,rss="],
          { maxBuffer: 4 * 1048576 },
          (error, data) => {
            sampling = false;
            if (error) return;
            const rows = data
              .trim()
              .split("\n")
              .map((s) => s.trim().split(/\s+/).map(Number));
            const pids = new Set([child.pid]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const [pid, ppid] of rows)
                if (pids.has(ppid) && !pids.has(pid)) {
                  pids.add(pid);
                  changed = true;
                }
            }
            sampledPeakTreeRssBytes = Math.max(
              sampledPeakTreeRssBytes,
              rows.reduce(
                (s, [pid, , rss]) => s + (pids.has(pid) ? rss * 1024 : 0),
                0,
              ),
            );
          },
        );
      }, 100);
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      const code = await new Promise<number | null>((ok, no) => {
        child.once("error", no);
        child.once("exit", ok);
      });
      clearInterval(timer);
      const wallMs = performance.now() - started;
      await writeFile(out + ".stdout.log", stdout);
      await writeFile(out + ".stderr.log", stderr);
      if (code !== 0)
        throw Error(
          `${variant} build failed (${code}): ${stderr.slice(-2000)}`,
        );
      const manifest = JSON.parse(
        await readFile(out + "/manifest.json", "utf8"),
      );
      const rss =
        platform() === "darwin"
          ? stderr.match(/(\d+)\s+maximum resident set size/)
          : stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
      const usage = stderr.match(
        /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/,
      );
      const row = {
        variant,
        count,
        round,
        startedAt,
        wallMs,
        cpuUserMs: usage ? Number(usage[2]) * 1000 : null,
        cpuSysMs: usage ? Number(usage[3]) * 1000 : null,
        sampledPeakTreeRssBytes,
        peakBuilderRssBytes: rss
          ? Number(rss[1]) * (platform() === "darwin" ? 1 : 1024)
          : null,
        manifest,
        out,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      await writeFile(
        root + "/results.json",
        JSON.stringify(
          {
            kind: "Sequential complete offline builds; compilation excluded; includes source parsing, text compression, sorting, scoring, format construction and publication; OS caches uncontrolled; time RSS is the maximum individual process; sampledPeakTreeRssBytes is the sum over command descendants sampled every 100 ms, not an exact peak",
            node: process.version,
            platform: platform(),
            arch: arch(),
            cpus: cpus()[0]?.model,
            threads,
            batchMiB,
            hashes,
            rows,
          },
          null,
          2,
        ),
      );
      if (
        process.env.BENCH_CLEAN === "1" &&
        !(
          process.env.BENCH_KEEP_LAST_RUST === "1" &&
          variant === "rust" &&
          round === repeats - 1
        )
      ) {
        await rm(out + "/packs", { recursive: true, force: true });
        await rm(out + "/staging", { recursive: true, force: true });
      }
    }
  }
