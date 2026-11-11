import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "../builder/build.js";
import { generate } from "./generate.js";
import { BinaryIndex } from "../format/index.js";
import { FileStorage } from "../storage/filesystem.js";
import { search } from "../query/engine.js";
import { upload } from "./upload.js";
import { Miniflare } from "miniflare";
const [command, ...args] = process.argv.slice(2),
  arg = (key: string, fallback: string) => {
    const i = args.indexOf("--" + key);
    return i < 0 ? fallback : args[i + 1];
  };
function wrangler(args: string[]) {
  const r = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("Wrangler command failed");
}
const out = arg("out", "indexes/current");
async function manifest() {
  const m = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  const { createHash } = await import("node:crypto");
  const binary = await readFile(join(out, "bundle.bin"));
  if (
    createHash("sha256").update(binary).digest("hex") !== m.bundleSha256 ||
    new BinaryIndex(binary).generation !== m.generation
  )
    throw new Error("Bundle/manifest mismatch");
  for (const o of m.objects) {
    const bytes = await readFile(join(out, "objects", o.key));
    if (
      bytes.length !== o.size ||
      createHash("sha256").update(bytes).digest("hex") !== o.sha256
    )
      throw new Error("Object checksum mismatch: " + o.key);
  }
  return m;
}
try {
  if (command === "generate") {
    await mkdir("data", { recursive: true });
    await generate(
      arg("output", "data/sample.jsonl"),
      Number(arg("count", "100")),
      Number(arg("seed", "42")),
    );
  } else if (command === "build") {
    const strategy = arg("strategy", "smallest");
    if (!["smallest", "workload"].includes(strategy))
      throw new Error("Unknown strategy");
    const workload = args.includes("--workload")
      ? (await readFile(arg("workload", ""), "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
    const result = await build({
      input: arg("input", "data/sample.jsonl"),
      out,
      budget: Number(arg("budget-mib", "8")) * 1024 * 1024,
      strategy: strategy as "smallest" | "workload",
      workload,
      chunkDocs: Number(arg("chunk-docs", "5000")),
    });
    await copyFile(join(out, "bundle.bin"), "data/bundle.bin");
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "search") {
    const index = new BinaryIndex(await readFile(join(out, "bundle.bin")));
    console.log(
      JSON.stringify(
        await search(
          index,
          new FileStorage(join(out, "objects")),
          arg("query", ""),
          {
            mode: arg("mode", "and") as "and" | "or",
            limit: Number(arg("limit", "20")),
            metadata: args.includes("--metadata"),
          },
        ),
        null,
        2,
      ),
    );
  } else if (command === "seed" || command === "deploy") {
    const m = await manifest(),
      remote = command === "deploy";
    if (remote) await upload(out, arg("bucket", "worker-search-index"), m);
    else {
      const mf = new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("seed");}}',
        r2Buckets: { INDEX: arg("bucket", "worker-search-index") },
        r2Persist: ".wrangler/state/v3/r2",
      });
      try {
        const bucket = await mf.getR2Bucket("INDEX");
        for (const o of m.objects)
          await bucket.put(o.key, await readFile(join(out, "objects", o.key)), {
            customMetadata: { generation: m.generation, sha256: o.sha256 },
          });
      } finally {
        await mf.dispose();
      }
    }
    await copyFile(join(out, "bundle.bin"), "data/bundle.bin");
    if (remote) wrangler(["deploy"]);
  } else if (command === "verify") {
    console.log((await manifest()).generation);
  } else
    throw new Error("Commands: generate, build, search, seed, deploy, verify");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
