import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { readFile, writeFile, rm, mkdir, copyFile, cp } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Root } from "../../../src/columnar/format.js";
export interface BuildOptions {
  input: string | string[];
  out: string;
  maxDocuments?: number;
  threads?: number;
  batchMiB?: number;
  retainStaging?: boolean;
  resume?: boolean;
  remoteStore?: { url: string; tokenFile: string };
}
let compiled: Promise<unknown> | undefined;
/** Frozen offline control/fixture builder. Production construction is TypeScript
 * on the constructor Worker, driven by scripts/build-in-workers.ts. */
export async function buildColumnar(options: BuildOptions): Promise<Root> {
  await (compiled ??= promisify(execFile)(
    "cargo",
    ["build", "--release", "--locked"],
    { maxBuffer: 2 * 1048576 },
  ));
  const inputs =
    typeof options.input === "string" ? [options.input] : options.input;
  const provenance = resolve(options.out + "/builder-source");
  await mkdir(provenance, { recursive: true });
  await cp("crates/index-builder/src", provenance + "/src", {
    recursive: true,
  });
  await Promise.all([
    copyFile(
      "target/release/work-search-builder",
      provenance + "/work-search-builder",
    ),
    copyFile("Cargo.lock", provenance + "/Cargo.lock"),
    copyFile("crates/index-builder/Cargo.toml", provenance + "/Cargo.toml"),
    copyFile("crates/index-builder/build.rs", provenance + "/build.rs"),
    copyFile(
      "crates/index-builder/unicode-tables.mjs",
      provenance + "/unicode-tables.mjs",
    ),
  ]);
  const nativeBinarySha256 = createHash("sha256")
      .update(await readFile(provenance + "/work-search-builder"))
      .digest("hex"),
    cargoLockSha256 = createHash("sha256")
      .update(await readFile(provenance + "/Cargo.lock"))
      .digest("hex");
  const child = spawn(
    provenance + "/work-search-builder",
    [
      "build",
      "--input",
      "-",
      "--out",
      options.out,
      "--threads",
      String(options.threads ?? 8),
      "--batch-mib",
      String(options.batchMiB ?? 16),
      ...(options.maxDocuments === undefined
        ? []
        : ["--max-docs", String(options.maxDocuments)]),
      ...(!options.retainStaging ? ["--reclaim-staging"] : []),
      ...(options.resume ? ["--resume"] : []),
      ...(options.remoteStore
        ? [
            "--remote-url",
            options.remoteStore.url,
            "--remote-token-file",
            options.remoteStore.tokenFile,
          ]
        : []),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = new Promise<number | null>((ok, no) => {
    child.once("error", no);
    child.once("exit", ok);
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let summary = "";
  child.stdout.on("data", (b) => {
    if (summary.length < 1048576) summary += b.toString();
  });
  async function* bytes() {
    for (const input of inputs) {
      const file = input === "-" ? process.stdin : createReadStream(input);
      const stream = input.endsWith(".gz") ? file.pipe(createGunzip()) : file;
      try {
        for await (const chunk of stream) yield chunk;
      } finally {
        stream.destroy();
        file.destroy();
      }
      yield Buffer.from("\n");
    }
  }
  const transfer = pipeline(Readable.from(bytes()), child.stdin).catch(
    (e) => e,
  );
  const code = await exited,
    transferError = await transfer;
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  if (code !== 0) throw Error(`Native index builder exited ${code}`);
  if (
    transferError &&
    !["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(transferError.code)
  )
    throw transferError;
  const root: Root = JSON.parse(
    await readFile(options.out + "/root.json", "utf8"),
  );
  await writeFile(
    options.out + "/source.json",
    JSON.stringify(
      {
        inputs: inputs.map((p) => (p === "-" ? p : resolve(p))),
        ...options,
        input: undefined,
        nativeSummary: JSON.parse(summary),
        nativeBinarySha256,
        cargoLockSha256,
      },
      null,
      2,
    ),
  );
  if (!options.retainStaging)
    await rm(options.out + "/staging", { recursive: true, force: true });
  return root;
}
