import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { ColumnarIndex, type Options } from "../../src/columnar/search.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { Memory, Lru, Reader } from "../../src/columnar/storage.js";
import {
  executePackets,
  packetPlan,
} from "../../src/columnar/packet-execution.js";
import { lookupRemotePairs } from "../../src/columnar/pair-lookup.js";
import { parse, queryTerms, simplify } from "../../src/query/parser.js";
import { tokenizerFor } from "../../src/query/analysis.js";
import type { Root } from "../../src/columnar/format.js";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";
import { benchmarkToken } from "./token.js";
import { PairRouter } from "../../src/columnar/pair-router.js";
import { ExactPhraseDirectory } from "../../src/columnar/exact-phrase-directory.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
async function implementationDigest() {
  const hash = createHash("sha256");
  async function visit(path: string) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path + "/" + item.name;
      if (item.isDirectory()) await visit(file);
      else hash.update(file).update(await readFile(file));
    }
  }
  for (const path of ["src/columnar", "src/query", "src/format"])
    await visit(path);
  for (const file of ["simulate.ts", "local-storage.ts", "latency-model.ts"])
    hash.update(file).update(await readFile("bench/columnar/" + file));
  return hash.digest("hex");
}
const implementationSha256 = await implementationDigest();

const dir = process.argv[2],
  contract = process.argv[3],
  label = process.env.CWS_LABEL ?? "local-simulation",
  store = process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
  condition = process.env.CWS_CONDITION ?? "memory-reuse",
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  sharedBudget = Number(process.env.CWS_SHARED_BUDGET ?? 900),
  primeSharedBudget = Number(
    process.env.CWS_PRIME_SHARED_BUDGET ?? sharedBudget,
  ),
  primePasses = Number(process.env.CWS_PRIME_PASSES ?? 1),
  plans = [
    ...(process.env.CWS_PLANS ?? "auto,complete-terms,documents,blocks").split(
      ",",
    ),
    ...(process.env.CWS_PAIR_SETTINGS ?? "")
      .split(",")
      .filter(Boolean)
      .map((s) => "auto-N" + s.replace(":", "-M")),
  ];
if (
  !dir ||
  !contract ||
  !["memory-reuse", "shared-warm-memory-empty", "fresh-namespace"].includes(
    condition,
  ) ||
  !Number.isInteger(sharedBudget) ||
  sharedBudget < 0 ||
  !Number.isInteger(primeSharedBudget) ||
  primeSharedBudget < 0 ||
  !Number.isInteger(primePasses) ||
  primePasses < 1 ||
  primePasses > 10 ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  plans.some(
    (p) =>
      !["auto", "complete-terms", "documents", "blocks"].includes(p) &&
      !/^(auto|control)-N\d+-M\d+$/.test(p),
  )
)
  throw Error(
    "Usage: simulate.ts INDEX_DIR ORACLE.json [--prepare] [--prepare-only]",
  );
const root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  scenarios = JSON.parse(await readFile(contract, "utf8"));
if (
  root.count !== 1000000 ||
  root.count !== scenarios.count ||
  root.corpusHash !== scenarios.corpusHash ||
  root.analysis !== scenarios.analysis
)
  throw Error("Simulation requires a matching 1M corpus and analysis contract");
const raw = await readFile(dir + "/directory.bin"),
  documentRaw = await readFile(dir + "/documents.bin"),
  pairRaw = process.env.CWS_PAIR_INDEX
    ? await readFile(process.env.CWS_PAIR_INDEX + "/router.bin")
    : undefined;
const commonPresence = process.env.CWS_PAIR_INDEX
  ? JSON.parse(
      await readFile(process.env.CWS_PAIR_INDEX + "/presence.json", "utf8"),
    )
  : undefined;
const exactPhraseRaw = process.env.CWS_PAIR_INDEX
  ? await readFile(process.env.CWS_PAIR_INDEX + "/exact-phrases.bin").catch(
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      },
    )
  : undefined;
if (
  createHash("sha256").update(raw).digest("hex") !== root.directory?.sha256 ||
  createHash("sha256").update(documentRaw).digest("hex") !==
    root.documentPackages?.locators?.sha256
)
  throw Error("Local bundled directory identity mismatch");
const source = new LocalObjects(
    root,
    store,
    process.argv.includes("--prepare") ||
      process.argv.includes("--prepare-only")
      ? {
          url: "https://work-search-cws-upload.phulin.workers.dev",
          token: await benchmarkToken(),
        }
      : undefined,
  ),
  model = {
    r2Ms: Number(process.env.CWS_R2_MS ?? 20),
    sharedMs: Number(process.env.CWS_SHARED_MS ?? 2),
    r2MiBPerSecond: Number(process.env.CWS_R2_MIBPS ?? 100),
    sharedMiBPerSecond: Number(process.env.CWS_SHARED_MIBPS ?? 1000),
    jitterMs: Number(process.env.CWS_R2_JITTER_MS ?? 0),
    seed: Number(process.env.CWS_SEED ?? 20261113),
  },
  sharedCacheMiB = Number(process.env.CWS_SHARED_CACHE_MIB ?? 256);
source.namedDirectory = process.env.CWS_PAIR_INDEX;
const controlModule = (name: string) =>
  import(
    pathToFileURL(
      resolve(process.env.CWS_CONTROL_SOURCE!, "src/columnar/" + name + ".ts"),
    ).href
  );
const [controlSearch, controlStorage, controlDirectory, controlDocuments] =
  process.env.CWS_CONTROL_SOURCE
    ? await Promise.all(
        ["search", "storage", "term-directory", "document-directory"].map(
          controlModule,
        ),
      )
    : [];
const [autoSearch, autoStorage, autoDirectory, autoDocuments] = process.env
  .CWS_AUTO_SOURCE
  ? await Promise.all(
      ["search", "storage", "term-directory", "document-directory"].map(
        (name) =>
          import(
            pathToFileURL(
              resolve(
                process.env.CWS_AUTO_SOURCE!,
                "src/columnar/" + name + ".ts",
              ),
            ).href
          ),
      ),
    )
  : [];
// Older instrumented controls intentionally use today's Reader counters. The
// untouched CPU control freezes the entire runtime explicitly.
const freezeRuntime = process.env.CWS_CONTROL_RUNTIME === "frozen";
const ControlObjects =
  process.env.CWS_CONTROL_INDEX && freezeRuntime
    ? (
        await import(
          pathToFileURL(
            resolve(
              process.env.CWS_CONTROL_SOURCE!,
              "bench/columnar/local-storage.ts",
            ),
          ).href
        )
      ).LocalObjects
    : LocalObjects;
const controlAssets = process.env.CWS_CONTROL_INDEX
  ? {
      root: JSON.parse(
        await readFile(process.env.CWS_CONTROL_INDEX + "/root.json", "utf8"),
      ),
      raw: await readFile(process.env.CWS_CONTROL_INDEX + "/directory.bin"),
      documents: await readFile(
        process.env.CWS_CONTROL_INDEX + "/documents.bin",
      ),
      pairs: await readFile(
        process.env.CWS_CONTROL_INDEX + "/pairs/router.bin",
      ),
      presence: JSON.parse(
        await readFile(
          process.env.CWS_CONTROL_INDEX + "/pairs/presence.json",
          "utf8",
        ),
      ),
    }
  : undefined;
const runtimes = new Map(
  plans.map((plan) => {
    const assets = plan.startsWith("control-") ? controlAssets : undefined,
      runtimeRoot = assets?.root ?? root,
      runtimeSource = assets ? new ControlObjects(runtimeRoot, store) : source;
    if (assets)
      runtimeSource.namedDirectory = process.env.CWS_CONTROL_INDEX + "/pairs";
    const setting = /^(?:auto|control)-N(\d+)-M(\d+)$/.exec(plan),
      membership =
        setting && pairRaw
          ? {
              router: new PairRouter(assets?.pairs ?? pairRaw),
              N: Number(setting[1]),
              M: Number(setting[2]),
              presence: assets?.presence ?? commonPresence,
              exactPhrases:
                !plan.startsWith("control-") && exactPhraseRaw
                  ? new ExactPhraseDirectory(exactPhraseRaw)
                  : undefined,
            }
          : undefined;
    if (setting && !membership)
      throw Error("Pair settings require CWS_PAIR_INDEX");
    const frozen = plan.startsWith("control-") && !!controlSearch,
      Store: typeof import("../../src/columnar/storage.js") =
        frozen && freezeRuntime
          ? controlStorage
          : autoSearch && !frozen
            ? autoStorage
            : ({ Reader, Memory, Lru } as any),
      ReaderClass = Store.Reader,
      Index: typeof ColumnarIndex = frozen
        ? controlSearch.ColumnarIndex
        : (autoSearch?.ColumnarIndex ?? ColumnarIndex),
      Directory: typeof TermDirectory =
        frozen && freezeRuntime
          ? controlDirectory.TermDirectory
          : (autoDirectory?.TermDirectory ?? TermDirectory),
      Documents: typeof DocumentDirectory =
        frozen && freezeRuntime
          ? controlDocuments.DocumentDirectory
          : (autoDocuments?.DocumentDirectory ?? DocumentDirectory),
      memory = new Store.Memory(),
      directory = new Directory(assets?.raw ?? raw, runtimeRoot.count),
      documents = new Documents(assets?.documents ?? documentRaw),
      index = new Index(
        runtimeRoot,
        undefined,
        directory,
        undefined,
        documents,
        membership,
      ),
      blockIndex = new ColumnarIndex(
        runtimeRoot,
        undefined,
        undefined,
        undefined,
        documents,
      ),
      io = new SimulatedIO(runtimeSource, model, sharedCacheMiB);
    memory.pages = new Store.Lru(12 * 1048576);
    // Benchmark-only bypass of packet-plan selection, with identical addresses.
    blockIndex.terms = (names, reader) => directory.lookup(names, reader);
    return [
      plan,
      {
        memory,
        directory,
        documents,
        index,
        blockIndex,
        io,
        ReaderClass,
        root: runtimeRoot,
      },
    ] as const;
  }),
);
const rows: any[] = [],
  cursors = new Map<string, Options["after"]>();
const selected = scenarios.scenarios.filter(
  (s: any) =>
    !process.env.CWS_QUERY_FILTER || s.q.includes(process.env.CWS_QUERY_FILTER),
);
if (!selected.length) throw Error("No selected query contracts");
const reset = (plan?: string) => {
  for (const [key, { memory, directory }] of runtimes)
    if (plan === undefined || key === plan) {
      memory.clear();
      directory.clear();
    }
};
async function query(
  scenario: any,
  plan: string,
  prepare: boolean,
  namespace: string,
  budget = sharedBudget,
) {
  const {
    memory,
    directory,
    documents,
    index,
    blockIndex,
    io,
    ReaderClass,
    root,
  } = runtimes.get(plan)!;
  const deferred: Promise<unknown>[] = [],
    reader = new ReaderClass(
      root,
      prepare ? source : io.source,
      memory,
      prepare ? undefined : io.shared,
      namespace,
      (p) => {
        deferred.push(p);
      },
      { remaining: budget },
    ),
    options = { ...scenario.options },
    callsBefore = { ...io.calls },
    cpu = process.cpuUsage(),
    started = performance.now();
  if (options.after)
    options.after =
      cursors.get(plan + ":" + selected.indexOf(scenario)) ?? options.after;
  const packages = {
    averageBytes: root.documentPackages!.averageBytes,
    byteLength: (doc: number) =>
      documents.lookup(doc).verificationBytes ?? documents.lookup(doc).length,
    load: (doc: number, wanted?: Set<number>) =>
      reader.document(
        root.documentPackages!.generation,
        doc,
        documents.lookup(doc),
        wanted,
      ),
  };
  let result;
  if (
    plan === "auto" ||
    plan.startsWith("auto-N") ||
    plan.startsWith("control-N")
  )
    result = await index.search(scenario.q, reader, options);
  else {
    const original = parse(
        scenario.q,
        options.mode,
        tokenizerFor(root.analysis),
      ),
      terms = await directory.lookup(queryTerms(original), reader),
      ast = simplify(original, (n) => terms.has(n)),
      queryRoot = await lookupRemotePairs(ast, terms, root, reader, {
        ...packetPlan(
          ast,
          terms,
          root,
          options,
          packages,
          plan === "blocks"
            ? undefined
            : (plan as "complete-terms" | "documents"),
        ),
        ...(plan === "blocks" ? { kind: "blocks" as const } : {}),
      });
    if (plan === "blocks") {
      // Use the production block executor with this query's discovered pair
      // evidence. This adapter changes selection only, not execution logic.
      const forced: ColumnarIndex = Object.create(blockIndex);
      Object.defineProperty(forced, "root", { value: queryRoot });
      forced.terms = async () => terms;
      result = await forced.search(scenario.q, reader, options);
    } else
      result = await executePackets(
        ast,
        terms,
        queryRoot,
        reader,
        options,
        packages,
        plan as "complete-terms" | "documents",
      );
  }
  const body = Buffer.from(JSON.stringify(result ?? { unsupported: true })),
    wallMs = performance.now() - started,
    usage = process.cpuUsage(cpu);
  // Cache writes are not response latency; finish them before changing state.
  await Promise.all(deferred);
  if (result) {
    if (result.generation !== root.generation)
      throw Error("Result generation mismatch");
    const want = scenario.oracle;
    if (
      options.exactTotal &&
      typeof scenario.total === "number" &&
      result.total !== scenario.total
    )
      throw Error("Exact total mismatch: " + scenario.q + ":" + plan);
    if (
      result.results.length !== want.length ||
      result.results.some(
        (h, i) =>
          h.id !== want[i].id ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(want[i].score)) ||
          (options.metadata !== false &&
            JSON.stringify([h.title, h.metadata]) !==
              JSON.stringify([want[i].title, want[i].metadata])) ||
          (options.snippets !== false && typeof h.snippet !== "string"),
      )
    )
      throw Error("Independent oracle mismatch: " + scenario.q + ":" + plan);
    if (scenario.assertPhraseSnippet && options.snippets !== false) {
      const analyze = tokenizerFor(root.analysis),
        words = analyze(scenario.q);
      for (const hit of result.results) {
        const tokens = analyze(hit.snippet ?? "");
        let found = false;
        outer: for (let at = 0; at + words.length <= tokens.length; at++) {
          for (let i = 0; i < words.length; i++)
            if (tokens[at + i] !== words[i]) continue outer;
          found = true;
          break;
        }
        if (!found)
          throw Error(
            "Query-relevant phrase missing from snippet: " +
              scenario.q +
              ":" +
              plan +
              ":" +
              hit.id,
          );
      }
    }
  }
  return {
    q: scenario.q,
    kind: scenario.kind,
    options,
    plan,
    unsupported: !result,
    wallMs,
    localProcessCpuMs: (usage.user + usage.system) / 1000,
    responseBytes: body.length,
    // Outside the timed response: verify exact score bits, rendering and totals
    // across independently frozen runtimes as well as the source oracle.
    resultSha256: result
      ? createHash("sha256")
          .update(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(result).filter(([k]) => k !== "diagnostics"),
              ),
            ),
          )
          .digest("hex")
      : undefined,
    semanticSha256: result
      ? createHash("sha256")
          .update(
            JSON.stringify({
              corpusHash: root.corpusHash,
              total: result.total,
              results: result.results.map(({ score: _score, ...hit }) => hit),
            }),
          )
          .digest("hex")
      : undefined,
    modeledIO: Object.fromEntries(
      Object.entries(io.calls).map(([key, value]) => [
        key,
        value - callsBefore[key as keyof typeof callsBefore],
      ]),
    ),
    diagnostics: result?.diagnostics,
  };
}
// Resolve pagination using this executor's exact score bits, after checking the
// independent predecessor. Do this outside timed measurements for every plan.
async function resolveCursors() {
  for (const [i, s] of selected.entries()) {
    if (!s.options?.after) continue;
    for (const [plan, runtime] of runtimes) {
      const predecessor = await runtime.index.search(
          s.q,
          new runtime.ReaderClass(
            runtime.root,
            runtime.io.source,
            runtime.memory,
          ),
          { ...s.options, after: undefined },
        ),
        last = predecessor.results.at(-1)!,
        expected = s.cursorPredecessor ?? s.options.after;
      if (
        !last ||
        last.doc !== expected.doc ||
        Math.abs(last.score - expected.score) >
          1e-11 * Math.max(1, Math.abs(expected.score))
      )
        throw Error("Local cursor predecessor mismatch");
      cursors.set(plan + ":" + i, { doc: last.doc, score: last.score });
    }
  }
}
source.remoteEnabled = !!source.remote;
await resolveCursors();
if (source.remoteEnabled) {
  for (const scenario of selected)
    for (const plan of plans) {
      reset(plan);
      await query(scenario, plan, true, "prepare");
      console.log("Prepared", plan, scenario.q, source.downloadedBytes);
    }
  reset();
  source.remoteEnabled = false;
}
if (process.argv.includes("--prepare-only")) process.exit(0);
// An untimed pass warms shared data and JIT execution. Fresh namespaces still
// miss both cache layers during measurements; application reset stays in-request.
for (const runtime of runtimes.values()) runtime.io.delaysEnabled = false;
for (const scenario of selected)
  for (const plan of plans) {
    reset(plan);
    const warmed = await query(
      scenario,
      plan,
      false,
      "simulation",
      primeSharedBudget,
    );
    console.log("Warmed", plan, scenario.q, Math.round(warmed.wallMs), "ms");
  }
reset();
for (const runtime of runtimes.values())
  runtime.io.delaysEnabled = process.env.CWS_NO_DELAY !== "1";
let seed = model.seed;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const manifest = {
  kind: "Local Node diagnostic with simulated R2/cache delays; not live Worker or client HTTP latency",
  generation: root.generation,
  corpusHash: root.corpusHash,
  analysis: root.analysis,
  documents: root.count,
  format: root.format,
  model,
  comparisonSeed: model.seed,
  sharedCacheMiB,
  sharedBudget,
  primeSharedBudget,
  primePasses,
  artificialDelays: process.env.CWS_NO_DELAY !== "1",
  cacheIsolation:
    process.env.CWS_ISOLATE_SCENARIOS === "1"
      ? "Independent caches per measured query/plan/repeat; one untimed same-query priming pass for warm conditions"
      : "Independent application and shared caches per plan; common immutable disk backing",
  condition,
  plans,
  repeats,
  contracts: selected.length,
  contractFile: contract,
  contractSha256: createHash("sha256")
    .update(await readFile(contract))
    .digest("hex"),
  node: process.version,
  responseCaching: false,
  pairRouterSha256: pairRaw
    ? createHash("sha256").update(pairRaw).digest("hex")
    : undefined,
  exactPhraseDirectorySha256: exactPhraseRaw
    ? createHash("sha256").update(exactPhraseRaw).digest("hex")
    : undefined,
  includes:
    "Matching, exact ranking, metadata, query-relevant snippet and JSON serialization",
  preparedDownloads: source.downloads,
  preparedBytes: source.downloadedBytes,
  warmup:
    "Bounded cache population without artificial delays, using primeSharedBudget; measured delays follow artificialDelays",
  startedAt: new Date().toISOString(),
  implementationSha256,
  controlSource: process.env.CWS_CONTROL_SOURCE,
  controlIndex: process.env.CWS_CONTROL_INDEX,
  controlGeneration: controlAssets?.root.generation,
  autoSource: process.env.CWS_AUTO_SOURCE,
  controlRuntime: freezeRuntime ? "frozen" : "current-reader-instrumentation",
};
await mkdir("work/columnar-bench", { recursive: true });
const save = () =>
  writeFile(
    `work/columnar-bench/${label}.json.gz`,
    gzipSync(JSON.stringify({ manifest, rows })),
  );
for (let repeat = 0; repeat < repeats; repeat++) {
  const jobs = selected
    .flatMap((scenario: any) =>
      plans.map((plan) => ({ scenario, plan, random: random() })),
    )
    .sort((a: any, b: any) => a.random - b.random);
  for (const { scenario, plan } of jobs) {
    if (process.env.CWS_ISOLATE_SCENARIOS === "1") {
      const runtime = runtimes.get(plan)!;
      runtime.io.sharedBytes.clear();
      reset(plan);
      if (condition !== "fresh-namespace") {
        const delayed = runtime.io.delaysEnabled;
        runtime.io.delaysEnabled = false;
        for (let pass = 0; pass < primePasses; pass++) {
          reset(plan);
          await query(scenario, plan, false, "simulation", primeSharedBudget);
        }
        runtime.io.delaysEnabled = delayed;
      }
    }
    if (condition !== "memory-reuse") reset(plan);
    try {
      const row = await query(
        scenario,
        plan,
        false,
        condition === "fresh-namespace"
          ? `fresh-${repeat}-${rows.length}`
          : "simulation",
      );
      rows.push({ ...row, repeat });
      console.log(
        plan,
        scenario.q,
        row.unsupported ? "unsupported" : Math.round(row.wallMs) + " ms",
      );
    } catch (e) {
      rows.push({ q: scenario.q, plan, repeat, error: String(e) });
      await save();
      throw e;
    }
    await save();
  }
}
if ((await implementationDigest()) !== implementationSha256)
  throw Error(
    "Implementation changed during local measurement; rerun before comparing results",
  );
console.log("Saved local simulation", label, rows.length, "responses");
for (const plan of plans) {
  const all = rows.filter((r) => r.plan === plan),
    success = all.filter((r) => !r.error && !r.unsupported),
    quantiles = (values: number[]) => {
      values.sort((a, b) => a - b);
      return Object.fromEntries(
        [50, 95, 99].map((p) => [
          "p" + p,
          values[Math.ceil((values.length * p) / 100) - 1],
        ]),
      );
    };
  console.log(plan, {
    n: success.length,
    unsupported: all.length - success.length,
    wallMs: quantiles(success.map((r) => r.wallMs)),
    localProcessCpuMs: quantiles(success.map((r) => r.localProcessCpuMs)),
  });
}
