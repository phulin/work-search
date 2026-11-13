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
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  plans.some(
    (p) =>
      !["auto", "complete-terms", "documents", "blocks"].includes(p) &&
      !/^auto-N\d+-M\d+$/.test(p),
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
    seed: 20261113,
  },
  sharedCacheMiB = Number(process.env.CWS_SHARED_CACHE_MIB ?? 256);
source.namedDirectory = process.env.CWS_PAIR_INDEX;
const runtimes = new Map(
  plans.map((plan) => {
    const setting = /^auto-N(\d+)-M(\d+)$/.exec(plan),
      membership =
        setting && pairRaw
          ? {
              router: new PairRouter(pairRaw),
              N: Number(setting[1]),
              M: Number(setting[2]),
              presence: commonPresence,
            }
          : undefined;
    if (setting && !membership)
      throw Error("Pair settings require CWS_PAIR_INDEX");
    const memory = new Memory(),
      directory = new TermDirectory(raw, root.count),
      documents = new DocumentDirectory(documentRaw),
      index = new ColumnarIndex(
        root,
        undefined,
        directory,
        undefined,
        documents,
        membership,
      ),
      blockIndex = new ColumnarIndex(
        root,
        undefined,
        undefined,
        undefined,
        documents,
      ),
      io = new SimulatedIO(source, model, sharedCacheMiB);
    memory.pages = new Lru(12 * 1048576);
    // Benchmark-only bypass of packet-plan selection, with identical addresses.
    blockIndex.terms = (names, reader) => directory.lookup(names, reader);
    return [
      plan,
      { memory, directory, documents, index, blockIndex, io },
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
) {
  const { memory, directory, documents, index, blockIndex, io } =
    runtimes.get(plan)!;
  const deferred: Promise<unknown>[] = [],
    reader = new Reader(
      root,
      prepare ? source : io.source,
      memory,
      prepare ? undefined : io.shared,
      namespace,
      (p) => {
        deferred.push(p);
      },
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
    byteLength: (doc: number) => documents.lookup(doc).length,
    load: (doc: number) =>
      reader.document(
        root.documentPackages!.generation,
        doc,
        documents.lookup(doc),
      ),
  };
  let result;
  if (plan === "auto" || plan.startsWith("auto-N"))
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
    const want = scenario.oracle;
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
  const { index, memory } = runtimes.values().next().value!;
  for (const [i, s] of selected.entries()) {
    if (!s.options?.after) continue;
    const predecessor = await index.search(
        s.q,
        new Reader(root, source, memory),
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
    for (const plan of plans)
      cursors.set(plan + ":" + i, { doc: last.doc, score: last.score });
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
    const warmed = await query(scenario, plan, false, "simulation");
    console.log("Warmed", plan, scenario.q, Math.round(warmed.wallMs), "ms");
  }
reset();
for (const runtime of runtimes.values()) runtime.io.delaysEnabled = true;
let seed = 20261113;
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
  sharedCacheMiB,
  cacheIsolation:
    "Independent application and shared caches per plan; common immutable disk backing",
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
  includes:
    "Matching, exact ranking, metadata, query-relevant snippet and JSON serialization",
  preparedDownloads: source.downloads,
  preparedBytes: source.downloadedBytes,
  warmup:
    "Production execution and bounded cache population without artificial delays; all modeled delays enabled for measured responses",
  startedAt: new Date().toISOString(),
  implementationSha256,
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
