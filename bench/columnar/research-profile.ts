import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Session } from "node:inspector";
import { gzipSync } from "node:zlib";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { PairRouter } from "../../src/columnar/pair-router.js";
import { Reader, Memory, Lru } from "../../src/columnar/storage.js";
import { parse } from "../../src/query/parser.js";
import { tokenizerFor } from "../../src/query/analysis.js";
import type { Root } from "../../src/columnar/format.js";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";

const [dir, pairs, input, out] = process.argv.slice(2);
if (!out)
  throw Error("Usage: research-profile.ts INDEX PAIRS QUERIES.jsonl OUTPUT");
const phase = process.env.CWS_RESEARCH_PHASE ?? "measure",
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  seed = Number(process.env.CWS_SEED ?? 20261114);
if (
  !["measure", "profile"].includes(phase) ||
  !Number.isInteger(repeats) ||
  repeats < 1
)
  throw Error("Invalid phase/repeats");
const expansions: Record<string, string> = {
  seal: "(seal OR sealed OR sealing)",
  sanction: "(sanction OR sanctions OR sanctioned OR sanctioning)",
  retaliat:
    "(retaliate OR retaliated OR retaliating OR retaliation OR retaliatory)",
  proportion: "(proportion OR proportional OR proportionality)",
  withdraw: "(withdraw OR withdrawal OR withdrawn OR withdrawing)",
  amend: "(amend OR amended OR amendment OR amending)",
  competit: "(competition OR competitive OR competitor)",
  enforce: "(enforce OR enforced OR enforcement OR enforcing OR enforceable)",
  redact: "(redact OR redacted OR redaction OR redacting)",
};
interface Query {
  brief_id: string;
  query: string;
  query_style: string;
  research_purpose: string;
  original: string;
  rewritten: boolean;
}
const inputBytes = await readFile(input),
  queries: Query[] = inputBytes
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const r = JSON.parse(line),
        query = r.query.replace(
          /\b([A-Za-z]+)!/g,
          (_: string, root: string) => {
            if (!expansions[root]) throw Error("Unknown root: " + root);
            return expansions[root];
          },
        );
      return {
        brief_id: r.brief_id,
        original: r.query,
        query,
        rewritten: query !== r.query,
        query_style: r.query_style,
        research_purpose: r.research_purpose,
      };
    }),
  root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8"));
if (
  queries.length !== 180 ||
  new Set(queries.map((q) => q.brief_id)).size !== 180 ||
  root.count !== 1000000
)
  throw Error("Expected 180 unique queries and the local 1M index");
for (const q of queries) parse(q.query, "and", tokenizerFor(root.analysis));
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
async function sourceDigest() {
  const h = createHash("sha256");
  async function visit(path: string) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const name = path + "/" + item.name;
      if (item.isDirectory()) await visit(name);
      else h.update(name).update(await readFile(name));
    }
  }
  for (const path of ["src/columnar", "src/query", "src/format"])
    await visit(path);
  return h.digest("hex");
}
const implementationSha256 = await sourceDigest(),
  directoryRaw = await readFile(dir + "/directory.bin"),
  documentRaw = await readFile(dir + "/documents.bin"),
  routerRaw = await readFile(pairs + "/router.bin");
if (
  sha(directoryRaw) !== root.directory?.sha256 ||
  sha(documentRaw) !== root.documentPackages?.locators?.sha256
)
  throw Error("Directory identity mismatch");
const directory = new TermDirectory(directoryRaw, root.count),
  index = new ColumnarIndex(
    root,
    undefined,
    directory,
    undefined,
    new DocumentDirectory(documentRaw),
    {
      router: new PairRouter(routerRaw),
      N: 100,
      M: 1000,
      presence: JSON.parse(await readFile(pairs + "/presence.json", "utf8")),
    },
  ),
  source = new LocalObjects(
    root,
    process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
  ),
  memory = new Memory(),
  model = {
    r2Ms: 20,
    sharedMs: 2,
    r2MiBPerSecond: 100,
    sharedMiBPerSecond: 1000,
    jitterMs: 0,
    seed,
  },
  io = new SimulatedIO(source, model, 1024),
  options = {
    mode: "and" as const,
    limit: 20,
    field: "all" as const,
    titleBoost: 2,
    metadata: true,
    snippets: true,
    exactTotal: false,
  };
source.namedDirectory = pairs;
memory.pages = new Lru(12 * 1048576);
const reset = () => {
  memory.clear();
  directory.clear();
};
const hashes = new Map<string, string>();
interface Row {
  brief_id: string;
  query: string;
  query_style: string;
  condition: string;
  repeat: number;
  wallMs: number;
  cpuMs: number;
  batchCpuMs: number;
  responseBytes: number;
  resultCount: number;
  resultSha256: string;
  diagnostics: Record<string, unknown>;
  modeledIO: Record<string, number>;
}
async function run(q: Query) {
  const deferred: Promise<unknown>[] = [],
    reader = new Reader(root, io.source, memory, io.shared, "research", (p) =>
      deferred.push(p),
    ),
    before = { ...io.calls },
    cpu = process.cpuUsage(),
    start = performance.now(),
    result = await index.search(q.query, reader, options),
    body = JSON.stringify(result),
    wallMs = performance.now() - start,
    usage = process.cpuUsage(cpu);
  await Promise.all(deferred);
  const batch = process.cpuUsage(cpu),
    hash = sha(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(result).filter(([k]) => k !== "diagnostics"),
        ),
      ),
    );
  const old = hashes.get(q.brief_id);
  if (old && old !== hash)
    throw Error("Response changed across runs: " + q.brief_id);
  hashes.set(q.brief_id, hash);
  return {
    brief_id: q.brief_id,
    query: q.query,
    query_style: q.query_style,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1000,
    batchCpuMs: (batch.user + batch.system) / 1000,
    responseBytes: Buffer.byteLength(body),
    resultCount: result.results.length,
    resultSha256: hash,
    diagnostics: result.diagnostics as Record<string, unknown>,
    modeledIO: Object.fromEntries(
      Object.entries(io.calls).map(([k, v]) => [
        k,
        v - before[k as keyof typeof before],
      ]),
    ),
  };
}
let state = seed;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
};
const shuffled = <T>(values: T[]) =>
  values
    .map((value) => ({ value, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.value);
const rows: Row[] = [],
  errors: { brief_id: string; error: string; phase: string }[] = [];
await mkdir(out, { recursive: true });
const manifest = {
  kind: "Local 1M Node profiling with simulated I/O; no live Cloudflare or network",
  phase,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  implementationSha256,
  harnessSha256: sha(await readFile("bench/columnar/research-profile.ts")),
  input,
  inputSha256: sha(inputBytes),
  queries: queries.length,
  rewritten: queries.filter((q) => q.rewritten).length,
  generation: root.generation,
  corpusHash: root.corpusHash,
  analysis: root.analysis,
  pairRouterSha256: sha(routerRaw),
  options,
  N: 100,
  M: 1000,
  seed,
  repeats,
  model,
  appPageMiB: 12,
  decodedMiB: 4,
  sharedMiB: 1024,
  cacheMethod:
    "Per-query priming without delays, then random ordering of reused application memory and cleared application caches over the same warm shared namespace; one request at a time. Three random query orders. Not mixed-workload cache reuse or new isolates.",
  validation:
    "Original query syntax except nine explicit finite root rewrites. Exact response hashes checked across cache conditions/repetitions; no independent relevance or exhaustive 1M oracle for these new queries.",
  proximity:
    "Existing engine semantics: W/S=25 tokens, W/P=75 tokens, not true sentence/paragraph boundaries. Finite root alternatives are not full Lexis wildcard expansion.",
  startedAt: new Date().toISOString(),
  node: process.version,
};
await writeFile(
  out + "/queries.json",
  JSON.stringify(
    { sourceSha256: sha(inputBytes), expansions, queries },
    null,
    2,
  ) + "\n",
);
const save = async () => {
  if ((await sourceDigest()) !== implementationSha256)
    throw Error("Engine changed during profiling");
  await writeFile(
    out + "/" + phase + ".json.gz",
    gzipSync(
      JSON.stringify({
        manifest,
        rows,
        errors,
        downloads: source.downloads,
        completedAt: new Date().toISOString(),
      }),
    ),
  );
};
if (phase === "measure") {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const q of shuffled(queries)) {
      try {
        reset();
        io.sharedBytes.clear();
        io.delaysEnabled = false;
        await run(q);
        io.delaysEnabled = true;
        for (const condition of shuffled([
          "memory-reuse",
          "shared-warm-memory-empty",
        ])) {
          if (condition === "shared-warm-memory-empty") reset();
          rows.push({ ...(await run(q)), condition, repeat });
        }
        io.delaysEnabled = false;
        // A no-delay process-CPU observation after this query is warm.
        rows.push({ ...(await run(q)), condition: "cpu-no-delays", repeat });
        console.log(
          repeat,
          rows.length,
          q.brief_id,
          Math.round(rows.at(-1)!.cpuMs),
          "CPU ms",
          q.query,
        );
      } catch (error) {
        errors.push({ brief_id: q.brief_id, error: String(error), phase });
        console.error(q.brief_id, error);
      }
      if ((rows.length / 3) % 10 === 0 || errors.length) await save();
    }
    await save();
  }
} else {
  const session = new Session();
  session.connect();
  const post = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) =>
      session.post(method as any, params, (e, r) =>
        e ? reject(e) : resolve(r),
      ),
    );
  io.delaysEnabled = false;
  await mkdir(out + "/profiles", { recursive: true });
  for (const q of shuffled(queries)) {
    try {
      reset();
      io.sharedBytes.clear();
      await run(q);
      await run(q);
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", { interval: 500 });
      await post("Profiler.start");
      for (let repeat = 0; repeat < 4; repeat++)
        rows.push({ ...(await run(q)), condition: "cpu-profile", repeat });
      const { profile } = await post("Profiler.stop");
      await post("Profiler.disable");
      await writeFile(
        out + "/profiles/" + q.brief_id + ".cpuprofile.gz",
        gzipSync(JSON.stringify(profile)),
      );
      await post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let repeat = 0; repeat < 2; repeat++)
        rows.push({
          ...(await run(q)),
          condition: "allocation-profile",
          repeat,
        });
      const { profile: heap } = await post("HeapProfiler.stopSampling");
      await writeFile(
        out + "/profiles/" + q.brief_id + ".heapprofile.gz",
        gzipSync(JSON.stringify(heap)),
      );
      console.log(rows.length / 6, q.brief_id, q.query);
    } catch (error) {
      errors.push({ brief_id: q.brief_id, error: String(error), phase });
      // Do not leave a sampling session active after a failed query.
      await post("Profiler.stop").catch(() => {});
      await post("Profiler.disable").catch(() => {});
      await post("HeapProfiler.stopSampling").catch(() => {});
      console.error(q.brief_id, error);
    }
    if (rows.length % 60 === 0 || errors.length) await save();
  }
  session.disconnect();
}
await save();
if (errors.length || source.downloads) process.exitCode = 1;
