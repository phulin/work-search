import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "../../src/builder/build.js";
import { BinaryIndex } from "../../src/format/index.js";
import { FileStorage } from "../../src/storage/filesystem.js";
import { search } from "../../src/query/engine.js";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
import { benchmarkToken } from "./token.js";
const dir = process.argv[2] ?? "work/columnar-remote-pilot-v4";
async function run(args: string[]) {
  await new Promise<void>((ok, no) => {
    const child = spawn("yarn", args, { stdio: "inherit" });
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? ok() : no(Error("Remote pilot command exited " + code)),
    );
  });
}
await run([
  "wrangler",
  "deploy",
  "--config",
  "work/columnar-deploy/upload.json",
]);
await run([
  "node",
  "--import",
  "tsx",
  "bench/columnar/full-build.ts",
  dir,
  "1000",
]);
await build({
  input: dir + "/corpus.jsonl.gz",
  out: dir + "/reference",
  budget: 8 * 1048576,
});
await run([
  "node",
  "--import",
  "tsx",
  "scripts/deploy-columnar.ts",
  dir,
  "work-search-cws-remote-pilot",
  "--deploy-only",
]);
const reference = new BinaryIndex(
    await readFile(dir + "/reference/bundle.bin"),
  ),
  storage = new FileStorage(dir + "/reference/objects"),
  token = await benchmarkToken(),
  rows = [];
for (const { q } of [...demoWorkload, ...globalQueries]) {
  for (const field of ["all", "body", "title"] as const) {
    const options = { q, field, limit: 20, resetMemory: true },
      want = await search(reference, storage, q, {
        field,
        limit: 20,
        internalDoc: true,
        exactTotal: true,
        metadata: true,
      });
    const response = await fetch(
        "https://work-search-cws-remote-pilot.phulin.workers.dev/search",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(options),
        },
      ),
      got = (await response.json()) as any;
    if (
      !response.ok ||
      got.results.length !== want.results.length ||
      got.results.some(
        (r: any, i: number) =>
          r.id !== want.results[i].id ||
          JSON.stringify([r.title, r.metadata]) !==
            JSON.stringify([want.results[i].title, want.results[i].metadata]) ||
          typeof (r.snippet ?? r.excerpt) !== "string" ||
          Math.abs(r.score - want.results[i].score) >
            1e-11 * Math.max(1, Math.abs(want.results[i].score)),
      )
    )
      throw Error(
        "Remote pilot correctness failed " +
          q +
          ":" +
          field +
          " " +
          JSON.stringify(got),
      );
    rows.push({
      q,
      field,
      status: response.status,
      results: got.results.length,
      diagnostics: got.diagnostics,
    });
  }
}
await writeFile(
  dir + "/live-correctness.json",
  JSON.stringify({ at: new Date().toISOString(), rows }, null, 2),
);
await run([
  "node",
  "--import",
  "tsx",
  "bench/columnar/cleanup-staging.ts",
  dir,
]);
console.log(
  "Verified remote spill construction, complete live responses, and temporary cleanup",
  rows.length,
);
