/** Local-only complete responses; both forced continuations receive identical IDs. */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import {
  ColumnarIndex,
  type ContinuationContext,
} from "../../src/columnar/search.js";
import { Reader, Memory, Lru } from "../../src/columnar/storage.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { PairRouter } from "../../src/columnar/pair-router.js";
import { lower } from "../../src/columnar/format.js";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";
const [dir, pairs, contractFile, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "Usage: stream-packages.ts INDEX PAIRS CONTRACT.json OUTPUT.json.gz",
  );
const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
async function digest() {
  const h = createHash("sha256");
  async function walk(p: string) {
    for (const e of (await readdir(p, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const f = p + "/" + e.name;
      if (e.isDirectory()) await walk(f);
      else h.update(f).update(await readFile(f));
    }
  }
  await walk("src/columnar");
  await walk("src/query");
  for (const p of [
    "bench/columnar/stream-packages.ts",
    "bench/columnar/local-storage.ts",
    "bench/columnar/latency-model.ts",
  ])
    h.update(p).update(await readFile(p));
  return h.digest("hex");
}
const sourceSha256 = await digest(),
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  contractRaw = await readFile(contractFile),
  contract = JSON.parse(contractRaw.toString()),
  routerRaw = await readFile(pairs + "/router.bin"),
  presence = JSON.parse(await readFile(pairs + "/presence.json", "utf8"));
if (
  root.count !== 1000000 ||
  root.corpusHash !== contract.corpusHash ||
  root.analysis !== contract.analysis
)
  throw Error("Expected matching local 1M corpus");
const source = new LocalObjects(
  root,
  process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
);
source.namedDirectory = pairs;
const model = {
    r2Ms: 20,
    sharedMs: 2,
    r2MiBPerSecond: 100,
    sharedMiBPerSecond: 1000,
    jitterMs: 0,
    seed: Number(process.env.CWS_SEED ?? 20261128),
  },
  variants = (process.env.CWS_VARIANTS ?? "postings,documents").split(","),
  conditions = (
    process.env.CWS_CONDITIONS ??
    "memory-reuse,shared-warm-memory-empty,fresh-namespace"
  ).split(","),
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  delay = process.env.CWS_NO_DELAY !== "1";
if (
  variants.some((v) => !["postings", "documents", "auto"].includes(v)) ||
  conditions.some(
    (c) =>
      !["memory-reuse", "shared-warm-memory-empty", "fresh-namespace"].includes(
        c,
      ),
  ) ||
  !Number.isInteger(repeats) ||
  repeats < 1
)
  throw Error("Invalid experiment options");
let captured: any;
class Experiment extends ColumnarIndex {
  variant = "auto";
  protected override async chooseContinuation(c: ContinuationContext) {
    const a = c.packages?.membership;
    if (!a) throw Error("Experiment requires pair-derived candidates");
    const ids = Uint32Array.from(
      [...a.values()].filter(
        (d) => !c.packages?.presenceFilter || c.packages.presenceFilter(d),
      ),
    );
    captured = {
      count: ids.length,
      sha256: sha(new Uint8Array(ids.buffer)),
      bytes: Array.from(
        ids,
        (d) => this.documentDirectory!.lookup(d).length,
      ).reduce((n, b) => n + b, 0),
      initialReads: c.reader.stats.requests,
      initialSharedGets: c.reader.stats.sharedGets,
      initialBytes: c.reader.stats.bytes,
    };
    // Canonical sorted IDs are harness-only. The same anchor object feeds packet
    // execution and the block loop, including its candidate-window cursors.
    Object.assign(a, {
      count: ids.length,
      values: function* () {
        yield* ids;
      },
      has: (doc: number) => ids[lower(ids, doc)] === doc,
      cursor: () => {
        let at = 0;
        return { next: () => (at < ids.length ? ids[at++] : Infinity) };
      },
    });
    if (this.variant === "auto") return super.chooseContinuation(c);
    return {
      ...c.plan,
      kind:
        this.variant === "documents"
          ? ("documents" as const)
          : ("blocks" as const),
      membershipAnchor: a,
      expectedCandidates: ids.length,
      expectedDocumentBytes: captured.bytes,
      gets: ids.length,
      dependentStages: 2,
    };
  }
}
const runtimes = new Map<string, any>();
for (const variant of variants) {
  const memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  const directory = new TermDirectory(
      await readFile(dir + "/directory.bin"),
      root.count,
    ),
    documents = new DocumentDirectory(await readFile(dir + "/documents.bin")),
    index = new Experiment(root, undefined, directory, undefined, documents, {
      router: new PairRouter(routerRaw),
      presence,
      N: 100,
      M: 1000,
    }),
    io = new SimulatedIO(source, model, 1024);
  index.variant = variant;
  runtimes.set(variant, { memory, directory, index, io });
}
const rows: any[] = [],
  expectedCandidates = new Map<string, string>();
async function run(s: any, variant: string, condition: string, rep: number) {
  const r = runtimes.get(variant);
  r.memory.clear();
  r.directory.clear();
  r.io.sharedBytes.clear();
  r.io.delaysEnabled = false;
  const execute = async (budget: number) => {
    const deferred: Promise<unknown>[] = [],
      reader = new Reader(
        root,
        r.io.source,
        r.memory,
        r.io.shared,
        "stream-experiment",
        (p) => deferred.push(p),
        { remaining: budget },
      ),
      before = { ...r.io.calls },
      start = performance.now(),
      cpu = process.cpuUsage(),
      result = await r.index.search(s.q, reader, s.options),
      body = JSON.stringify(result),
      wallMs = performance.now() - start,
      usage = process.cpuUsage(cpu);
    await Promise.all(deferred);
    const want = s.oracle;
    if (
      result.results.length !== want.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== want[i].id ||
          h.doc !== want[i].doc ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(want[i].score)) ||
          JSON.stringify([h.title, h.metadata]) !==
            JSON.stringify([want[i].title, want[i].metadata]) ||
          (s.options.snippets !== false && typeof h.snippet !== "string"),
      )
    )
      throw Error("Reference mismatch " + s.q + " " + variant);
    const old = expectedCandidates.get(s.q);
    if (old && old !== captured.sha256) throw Error("Candidate sets changed");
    expectedCandidates.set(s.q, captured.sha256);
    return {
      q: s.q,
      variant,
      condition,
      repeat: rep,
      wallMs,
      cpuMs: (usage.user + usage.system) / 1000,
      responseBytes: Buffer.byteLength(body),
      resultCount: result.results.length,
      rankedIdsSha256: sha(
        JSON.stringify(result.results.map((h: any) => [h.id, h.doc])),
      ),
      resultSha256: sha(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(result).filter(([k]) => k !== "diagnostics"),
          ),
        ),
      ),
      candidateInput: { ...captured },
      diagnostics: result.diagnostics,
      io: Object.fromEntries(
        Object.entries(r.io.calls).map(([k, v]) => [
          k,
          (v as number) - before[k as keyof typeof before],
        ]),
      ),
    };
  };
  if (condition !== "fresh-namespace") await execute(1000000);
  if (condition === "shared-warm-memory-empty") {
    r.memory.clear();
    r.directory.clear();
  }
  r.io.delaysEnabled = delay;
  return execute(900);
}
let seed = model.seed;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
const manifest = {
  kind: "Local 1M complete-response diagnostic; simulated I/O only; no network/preparation enabled.",
  sourceSha256,
  generation: root.generation,
  corpusHash: root.corpusHash,
  analysis: root.analysis,
  N: 100,
  M: 1000,
  format: root.format,
  model,
  variants,
  conditions,
  repeats,
  artificialDelays: delay,
  sharedCacheMiB: 1024,
  pageCacheMiB: 12,
  decodedCacheMiB: 4,
  primeSharedBudget: 1000000,
  measuredSharedBudget: 900,
  packageBatchBytes: 4 * 1048576,
  winnerPackageBytes: 4 * 1048576,
  packageConcurrency: 6,
  contractSha256: sha(contractRaw),
  routerSha256: sha(routerRaw),
  responseCaching: false,
  canonicalCandidates:
    "Harness materializes the exact same sorted initial membership IDs after presence filters for both continuations. Production streams membership cursors.",
  peakBuffers:
    "Accounted live raw/numeric buffers plus position arrays at 8 bytes/entry; excludes matcher objects, JS array slack, GC and inflated result text. Not peak heap or cumulative allocation.",
  startedAt: new Date().toISOString(),
};
await mkdir(dirname(output), { recursive: true });
const save = () =>
  writeFile(
    output,
    gzipSync(
      JSON.stringify({
        manifest,
        rows,
        downloads: source.downloads,
        completedAt: new Date().toISOString(),
      }),
    ),
  );
for (let rep = 0; rep < repeats; rep++) {
  const jobs = contract.scenarios
    .flatMap((s: any) =>
      variants.flatMap((v) =>
        conditions.map((c) => ({ s, v, c, order: rand() })),
      ),
    )
    .sort((a: any, b: any) => a.order - b.order);
  for (const { s, v, c } of jobs) {
    const row = await run(s, v, c, rep);
    rows.push(row);
    console.log(
      rep,
      v,
      c,
      Math.round(row.wallMs),
      "ms",
      row.candidateInput.count,
      (row.io.r2Bytes / 1048576).toFixed(1) + " origin MiB",
      s.q,
    );
    await save();
  }
}
if ((await digest()) !== sourceSha256)
  throw Error("Source changed during experiment");
if (source.downloads) throw Error("Unexpected download");
await save();
