import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PairCostTable } from "../src/global/pair-costs.js";
import { readFile, writeFile } from "node:fs/promises";
import { GlobalIndex } from "../src/global/search.js";
import { decodePairRoot, PairFilter } from "../src/global/pairs.js";
import { searchWithPairs } from "../src/global/pair-search.js";
import { demoWorkload } from "./demo-workload.js";
import { globalQueries } from "./global-workload.js";
import { ReadBudget, PageReader } from "../src/global/storage.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { crc32, encoder } from "../src/format/codec.js";
import { EmpiricalModel, sleep } from "./demo-model.js";
import { BinaryIndex } from "../src/format/index.js";
import { search } from "../src/query/engine.js";
const index = new GlobalIndex(
    await readFile(
      process.env.GLOBAL_BUNDLE ?? "work/global-100k/bundle-heads-8.bin",
    ),
  ),
  pairDir = process.env.GLOBAL_PAIRS,
  pairBytes = pairDir ? await readFile(pairDir + "/pairs.bin") : undefined,
  pairRoot = pairBytes ? decodePairRoot(pairBytes, index.root) : undefined,
  pairDisk = pairDir
    ? new FileStorage(pairDir + "/packs/" + pairRoot!.root.generation)
    : undefined,
  disk = new FileStorage("work/global-100k/packs"),
  samples = JSON.parse(
    await readFile("work/demo-bench/latency.json", "utf8"),
  ).rows,
  reference = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  ),
  oldDisk = new FileStorage("bench/generated/flp-100000/source/objects"),
  rows: any[] = [],
  oracle: Record<string, any> = {};
if (
  pairBytes &&
  (
    await readFile(
      process.env.GLOBAL_BUNDLE ?? "work/global-100k/bundle-heads-8.bin",
    )
  ).length +
    pairBytes.length >
    Number(process.env.GLOBAL_BUDGET ?? "8") * 1048576
)
  throw Error("Combined bundle exceeds configured budget");
const baselineIndex: GlobalIndex = process.env.GLOBAL_BASELINE_SEARCH
  ? new (
      await import(
        pathToFileURL(resolve(process.env.GLOBAL_BASELINE_SEARCH)).href
      )
    ).GlobalIndex(
      await readFile(
        process.env.GLOBAL_BUNDLE ?? "work/global-100k/bundle-heads-8.bin",
      ),
    )
  : index;
const fineDir = process.env.GLOBAL_FINE_DIR;
const fineIndex = fineDir
  ? new GlobalIndex(
      await readFile(
        fineDir + `/bundle-heads-${process.env.GLOBAL_BUDGET ?? 8}.bin`,
      ),
    )
  : undefined;
const fineDisk = fineDir ? new FileStorage(fineDir + "/packs") : undefined;
const costBytes = pairDir ? await readFile(pairDir + "/costs.bin") : undefined;
const pairCosts =
  costBytes && pairRoot
    ? new PairCostTable(
        costBytes,
        index.root.generation,
        pairRoot.root.generation,
      )
    : undefined;
const queries = [
  ...demoWorkload,
  ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
];
Object.assign(
  oracle,
  JSON.parse(
    await readFile("work/global-bench/competitive-oracle.json", "utf8"),
  ),
);
for (const q of queries)
  if (
    (!process.env.GLOBAL_QUERY_FILTER ||
      q.q.includes(process.env.GLOBAL_QUERY_FILTER)) &&
    !oracle[q.q]
  )
    oracle[q.q] = (
      await search(reference, oldDisk, q.q, {
        metadata: true,
        internalDoc: true,
        executor: "materialized",
      })
    ).results;
for (const [qi, q] of queries.entries()) {
  if (
    process.env.GLOBAL_QUERY_FILTER &&
    !q.q.includes(process.env.GLOBAL_QUERY_FILTER)
  )
    continue;
  for (const mode of qi % 2
    ? (process.env.GLOBAL_PROFILES ?? "pairs,windows").split(",").reverse()
    : (process.env.GLOBAL_PROFILES ?? "pairs,windows").split(",")) {
    if (
      process.env.GLOBAL_MODES &&
      !process.env.GLOBAL_MODES.split(",").includes(mode)
    )
      continue;
    const activeIndex =
      mode.startsWith("fine") || mode === "hybrid"
        ? fineIndex!
        : mode === "pairs"
          ? baselineIndex
          : index;
    if (!activeIndex) throw Error("GLOBAL_FINE_DIR required");
    const usesCosts = [
      "planned",
      "seeded",
      "fine",
      "fine-seeded",
      "hybrid",
    ].includes(mode);
    const bundleBytes =
      activeIndex.bundleBytes +
      pairBytes!.length +
      (usesCosts ? costBytes!.length : 0);
    if (bundleBytes > Number(process.env.GLOBAL_BUDGET ?? 8) * 1048576)
      throw Error("Combined bundle exceeds budget");
    const competitivePositions = false;
    const adaptivePositions = mode !== "baseline";
    if (mode !== "baseline" && mode !== "adaptive" && !pairRoot)
      throw Error("GLOBAL_PAIRS required");
    const source = {
      async open(key: string, offset: number, length: number) {
        const seed =
          crc32(encoder.encode(key + ":" + offset + ":" + length)) + qi;
        const latency = new EmpiricalModel(
          samples,
          seed,
          "empirical",
          "varied-range",
        ).sample(length);
        if (process.env.GLOBAL_NO_LATENCY !== "1")
          await sleep(latency.headersMs);
        return {
          bytes: (async () => {
            if (process.env.GLOBAL_NO_LATENCY !== "1")
              await sleep(latency.bodyMs);
            return (
              key.startsWith(pairRoot?.root.generation + "/")
                ? pairDisk!
                : mode.startsWith("fine") || mode === "hybrid"
                  ? fineDisk!
                  : disk
            ).read(key.split("/").at(-1)!, offset, length);
          })(),
        };
      },
      async read(key: string, offset: number, length: number) {
        return (await this.open(key, offset, length)).bytes;
      },
    };
    const budget = new ReadBudget(),
      memory = new SearchRuntime(8 * 1048576);
    const pairReader = pairRoot
      ? new PageReader(
          pairRoot.root,
          source,
          memory,
          undefined,
          undefined,
          true,
          "adaptive960",
          budget,
        )
      : undefined;
    const reader = new PageReader(
        { ...activeIndex.root, pageBytes: 262144, objectPages: 256 },
        source,
        memory,
        undefined,
        undefined,
        true,
        "adaptive960",
        budget,
      ),
      start = performance.now(),
      cpu = process.cpuUsage(),
      result = await searchWithPairs(
        activeIndex,
        reader,
        mode !== "baseline" && mode !== "adaptive"
          ? new PairFilter(
              pairRoot!,
              pairReader!,
              32768,
              process.env.GLOBAL_PAIR_INTERSECT === "1",
            )
          : undefined,
        q.q,
        {
          tokenWindows:
            mode !== "pairs" || process.env.GLOBAL_TOKEN_WINDOWS === "1",
          pairCosts: usesCosts ? pairCosts : undefined,
          cofetchPositions: usesCosts,
          adaptiveRetrieval: mode === "hybrid",
          completeSeeds: mode === "seeded" || mode === "fine-seeded",
          competitivePositions,
          adaptivePositions,
          adaptiveProbe:
            process.env.GLOBAL_ADAPTIVE_PROBE === "fused"
              ? "fused"
              : "competitive",
          decodedReads: process.env.GLOBAL_DECODED_READS !== "0",
        },
      ),
      used = process.cpuUsage(cpu),
      want = oracle[q.q];
    if (
      result.results.length !== want.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== want[i].id ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(h.score)) ||
          JSON.stringify([h.title, h.metadata]) !==
            JSON.stringify([want[i].title, want[i].metadata]),
      )
    )
      throw Error("Competitive ranking " + q.q);
    rows.push({
      mode,
      intersectPairs: process.env.GLOBAL_PAIR_INTERSECT === "1",
      configuredCompetitive: competitivePositions,
      ...q,
      group: qi < demoWorkload.length ? "legal" : "stress",
      bundleBytes,
      ms: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
      processPeakRssMiB: process.resourceUsage().maxRSS / 1024,
      ...result.diagnostics,
    });
    console.log(
      mode,
      q.q,
      Math.round(performance.now() - start),
      result.diagnostics.requests,
      result.diagnostics.verifiedDocuments,
    );
    await writeFile(
      "work/global-bench/" +
        (process.env.GLOBAL_COMPETITIVE_LABEL ?? "phrase-matrix") +
        (process.env.GLOBAL_NO_LATENCY === "1" ? "-cpu" : "") +
        ".json",
      JSON.stringify({
        budgetMiB: Number(process.env.GLOBAL_BUDGET ?? "8"),
        pairGeneration: pairRoot?.root.generation,
        kind: "Paired fixed per-page empirical R2 latency, complete-heads, 256KiB pages, cold memory and no shared cache; no latency mode measures local CPU only",
        rows,
      }),
    );
  }
}
