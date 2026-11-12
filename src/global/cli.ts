import { PairCostTable } from "./pair-costs.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildGlobal } from "./build.js";
import { GlobalIndex } from "./search.js";
import { PageReader, ReadBudget } from "./storage.js";
import { SearchRuntime } from "../query/runtime.js";
import { decodePairRoot, PairFilter } from "./pairs.js";
import { searchWithPairs } from "./pair-search.js";
import { FileStorage } from "../storage/filesystem.js";
const command = process.argv[2],
  { values: v } = parseArgs({
    args: process.argv.slice(3),
    options: {
      input: { type: "string" },
      source: { type: "string" },
      out: { type: "string", default: "work/global-index" },
      budgets: { type: "string", default: "8,16,32,48" },
      "page-kib": { type: "string", default: "128" },
      budget: { type: "string", default: "8" },
      query: { type: "string" },
      pairs: { type: "string" },
      "pair-costs": { type: "boolean", default: false },
      "token-windows": { type: "boolean", default: false },
      "cofetch-positions": { type: "boolean", default: false },
      "adaptive-retrieval": { type: "boolean", default: false },
      "complete-seeds": { type: "boolean", default: false },
      "score-cell-docs": { type: "string", default: "64" },
      "reserve-bytes": { type: "string", default: "0" },
      "intersect-pairs": { type: "boolean", default: false },
      "ids-only": { type: "boolean", default: false },
      base: { type: "boolean", default: false },
    },
  });
async function localIndex() {
  const binaryPath = resolve(
      v.out + `/${v.base ? "bundle" : "bundle-heads"}-${v.budget}.bin`,
    ),
    bytes = await readFile(binaryPath),
    index = new GlobalIndex(bytes),
    pairPath = v.pairs ? resolve(v.pairs + "/pairs.bin") : undefined,
    pairBytes = pairPath ? await readFile(pairPath) : undefined,
    pairs = pairBytes ? decodePairRoot(pairBytes, index.root) : undefined;
  if (v["pair-costs"] && !pairs) throw Error("--pair-costs requires --pairs");
  const costPath = v["pair-costs"]
    ? resolve(v.pairs + "/costs.bin")
    : undefined;
  const costBytes = costPath ? await readFile(costPath) : undefined;
  const pairCosts =
    costBytes && pairs
      ? new PairCostTable(
          costBytes,
          index.root.generation,
          pairs.root.generation,
        )
      : undefined;
  if (
    bytes.length + (pairBytes?.length ?? 0) + (costBytes?.length ?? 0) >
    Number(v.budget) * 1048576
  )
    throw Error("Combined bundle exceeds budget");
  return { binaryPath, index, pairPath, pairs, costPath, pairCosts };
}
if (command === "build") {
  if (!v.input) throw Error("--input is required");
  const result = await buildGlobal({
    input: v.input,
    source: v.source,
    out: v.out!,
    pageBytes: Number(v["page-kib"]) * 1024,
    scoreWindowDocs: Number(v["score-cell-docs"]),
    bundleReserveBytes: Number(v["reserve-bytes"]),
    budgets: v.budgets!.split(",").map((n) => Number(n) * 1048576),
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "search") {
  const { index, pairs, pairCosts } = await localIndex(),
    disk = new FileStorage(v.out + "/packs"),
    memory = new SearchRuntime(8 * 1048576),
    budget = new ReadBudget(),
    reader = new PageReader(
      index.root,
      {
        read: (key, offset, length) =>
          disk.read(key.split("/").at(-1)!, offset, length),
      },
      memory,
      undefined,
      undefined,
      true,
      undefined,
      budget,
    ),
    pairReader = pairs
      ? new PageReader(
          pairs.root,
          new FileStorage(v.pairs + "/packs"),
          memory,
          undefined,
          undefined,
          true,
          undefined,
          budget,
        )
      : undefined;
  console.log(
    JSON.stringify(
      await searchWithPairs(
        index,
        reader,
        pairs && pairReader
          ? new PairFilter(pairs, pairReader, 32768, v["intersect-pairs"])
          : undefined,
        v.query ?? "",
        {
          pairCosts,
          tokenWindows: v["token-windows"],
          cofetchPositions: v["cofetch-positions"],
          completeSeeds: v["complete-seeds"],
          adaptiveRetrieval: v["adaptive-retrieval"],
          metadata: !v["ids-only"],
          snippets: !v["ids-only"],
        },
      ),
      null,
      2,
    ),
  );
} else if (command === "dev") {
  const { Miniflare } = await import("miniflare"),
    { createHash } = await import("node:crypto");
  const { binaryPath, index, pairPath, pairs, costPath } = await localIndex(),
    persist = resolve(".wrangler/state"),
    dir = resolve("work/global-dev");
  await mkdir(dir, { recursive: true });
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("seed")}}',
    r2Buckets: { INDEX: "work-search-global" },
    r2Persist: persist + "/v3/r2",
  });
  try {
    const bucket = await mf.getR2Bucket("INDEX");
    for (const { root, packs } of [
      { root: index.root, packs: v.out + "/packs" },
      ...(pairs
        ? [
            {
              root: pairs.root,
              packs: v.pairs + "/packs/" + pairs.root.generation,
            },
          ]
        : []),
    ])
      for (const object of root.objects) {
        const bytes = await readFile(packs + "/" + object.name);
        if (
          bytes.length !== object.size ||
          createHash("sha256").update(bytes).digest("hex") !== object.sha256
        )
          throw Error("Local pack checksum mismatch");
        await bucket.put(root.generation + "/" + object.name, bytes, {
          customMetadata: {
            generation: root.generation,
            sha256: object.sha256,
          },
        });
      }
  } finally {
    await mf.dispose();
  }
  await writeFile(
    dir + "/entry.ts",
    `import binary from ${JSON.stringify(binaryPath)};${pairPath ? `import pairs from ${JSON.stringify(pairPath)};` : ""}${costPath ? `import costs from ${JSON.stringify(costPath)};` : ""}import {createGlobalWorker} from ${JSON.stringify(resolve("src/global/worker-runtime.ts"))};export default createGlobalWorker(new Uint8Array(binary)${pairPath ? ",new Uint8Array(pairs)" : ""}${costPath ? ",new Uint8Array(costs)" : ""});`,
  );
  const config = dir + "/wrangler.json";
  await writeFile(
    config,
    JSON.stringify({
      name: "work-search-global",
      main: dir + "/entry.ts",
      compatibility_date: "2026-11-01",
      rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-global" }],
      vars: {
        PAGE_CACHE: "1",
        PAGE_READ_KIB: "256",
        DIAGNOSTICS: "1",
        TOKEN_WINDOWS: v["token-windows"] ? "1" : "0",
        COFETCH_POSITIONS: v["cofetch-positions"] ? "1" : "0",
        ADAPTIVE_RETRIEVAL: v["adaptive-retrieval"] ? "1" : "0",
        COMPLETE_SEEDS: v["complete-seeds"] ? "1" : "0",
        PAIR_INTERSECT: v["intersect-pairs"] ? "1" : "0",
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      config,
      "--persist-to",
      persist,
    ],
    { stdio: "inherit" },
  );
  await new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 || code === null
        ? done()
        : reject(Error("Wrangler failed " + code)),
    );
  });
} else throw Error("Use build, search or dev");
