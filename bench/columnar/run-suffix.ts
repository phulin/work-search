import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ColumnarIndex } from "../../src/columnar/search.js";
import {
  Memory,
  Lru,
  Reader,
  Semaphore,
  type Source,
} from "../../src/columnar/storage.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import {
  loadServingAssets,
  servingOptions,
} from "../../scripts/columnar-serving.js";
import { SuffixReader } from "../../src/suffix/reader.js";
import { searchWithSuffix } from "../../src/suffix/search.js";
import { RangeStorage } from "./range-storage.js";
import { SimulatedIO } from "./latency-model.js";
import { benchmarkToken } from "./token.js";

const [index, suffixPath, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "Use INDEX_DIRECTORY SUFFIX_DIRECTORY_OR_DASH OUTPUT_GZ [--prepare-only]",
  );
const assets = await loadServingAssets(index, servingOptions()),
  root = assets.root,
  previous = JSON.parse(
    gunzipSync(
      await readFile("bench/results/columnar/fresh-1m-200/final-pass.json.gz"),
    ).toString(),
  );
if (
  root.count !== 1000000 ||
  previous.health.corpusHash !== root.corpusHash ||
  previous.health.analysis !== root.analysis
)
  throw Error("Different 1M corpus");
const scenarios = previous.scenarios.map((s: any, sid: number) => ({
  ...s,
  sid,
  options: { ...s.options, exactTotal: false, metadata: true, snippets: true },
  expected: previous.rows.find(
    (r: any) => r.sid === sid && !r.error && r.status === 200,
  )?.result.results,
}));
if (
  scenarios.length !== 200 ||
  scenarios.some((s: any) => !s.expected || s.options.after)
)
  throw Error("Expected complete 200-query contract without old cursors");
const model = {
    r2Ms: 20,
    r2MiBPerSecond: 100,
    sharedMs: 2,
    sharedMiBPerSecond: 1000,
    jitterMs: 0,
    seed: 879133,
  },
  storage = new RangeStorage(root, index + "/local-ranges", {
    url: "https://work-search-cws-upload.phulin.workers.dev",
    token: await benchmarkToken(),
  }),
  manifest =
    suffixPath !== "-"
      ? JSON.parse(await readFile(suffixPath + "/manifest.json", "utf8"))
      : undefined,
  plans = manifest
    ? ["control", "suffix16-scan", "suffix16-max", "suffix8-max"]
    : ["control"],
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  startedAt = new Date().toISOString(),
  frozen = resolve("work/suffix-control-9b4b887");
await mkdir(frozen, { recursive: true });
if (
  !(await readFile(frozen + "/src/columnar/search.ts").then(
    () => true,
    () => false,
  ))
)
  execFileSync("tar", ["-x", "-C", frozen], {
    input: execFileSync("git", ["archive", "9b4b887", "src"], {
      maxBuffer: 32 * 1048576,
    }),
  });
const control = await import(
    pathToFileURL(frozen + "/src/columnar/search.ts").href
  ),
  controlStorage = await import(
    pathToFileURL(frozen + "/src/columnar/storage.ts").href
  ),
  controlDirectory = await import(
    pathToFileURL(frozen + "/src/columnar/term-directory.ts").href
  ),
  controlDocuments = await import(
    pathToFileURL(frozen + "/src/columnar/document-directory.ts").href
  ),
  files = new Map<string, ReturnType<typeof open>>();
async function suffixRead(file: string, at: number, length: number) {
  let handle = files.get(file);
  if (!handle) files.set(file, (handle = open(suffixPath + "/" + file, "r")));
  const b = Buffer.allocUnsafe(length);
  if ((await (await handle).read(b, 0, length, at)).bytesRead !== length)
    throw Error("Truncated suffix file");
  return b;
}
function check(actual: any, s: any) {
  const expected = s.expected;
  if (
    JSON.stringify(actual.results.map((h: any) => h.doc)) !==
    JSON.stringify(expected.map((h: any) => h.doc))
  )
    throw Error("Ranked document mismatch: " + s.q);
  for (let i = 0; i < expected.length; i++) {
    const a = actual.results[i],
      e = expected[i];
    if (Math.abs(a.score - e.score) > 1e-10 * Math.max(1, Math.abs(e.score)))
      throw Error("Score mismatch: " + s.q);
    if (
      a.id !== e.id ||
      a.title !== e.title ||
      JSON.stringify(a.metadata) !== JSON.stringify(e.metadata)
    )
      throw Error("Display mismatch: " + s.q);
    if (a.snippet === undefined) throw Error("Missing query snippet");
  }
  if (actual.total !== undefined) throw Error("Exact totals must be off");
}
function limitSource(source: Source, slots: Semaphore): Source {
  return {
    read: (...args) => slots.run(() => source.read(...args)),
    readNamed: source.readNamed
      ? (...args) => slots.run(() => source.readNamed!(...args))
      : undefined,
    readPage: source.readPage
      ? (...args) => slots.run(() => source.readPage!(...args))
      : undefined,
    readWhole: source.readWhole
      ? (...args) => slots.run(() => source.readWhole!(...args))
      : undefined,
  };
}
async function query(s: any, plan: string, prepare: boolean) {
  const frozen = plan === "control",
    MemoryClass = frozen ? controlStorage.Memory : Memory,
    ReaderClass = frozen ? controlStorage.Reader : Reader,
    DirectoryClass = frozen ? controlDirectory.TermDirectory : TermDirectory,
    DocumentsClass = frozen
      ? controlDocuments.DocumentDirectory
      : DocumentDirectory,
    IndexClass = frozen ? control.ColumnarIndex : ColumnarIndex,
    memory = new MemoryClass();
  memory.pages = new Lru(12 * 1048576);
  memory.decoded = new Lru(4 * 1048576);
  const io = new SimulatedIO(storage, model),
    suffixIO = new SimulatedIO({ read: suffixRead }, model),
    slots = new Semaphore(6),
    engineSource = limitSource(io.source, slots),
    suffixSource = limitSource(suffixIO.source, slots),
    directory = new DirectoryClass(assets.directory!, root.count),
    documents = new DocumentsClass(assets.documents!),
    engine = new IndexClass(
      root,
      undefined,
      directory,
      undefined,
      documents,
      assets.membership,
    ),
    writes: Promise<any>[] = [],
    reader = new ReaderClass(
      root,
      prepare ? storage : engineSource,
      memory,
      prepare ? undefined : io.shared,
      "cold-" + randomUUID(),
      (p: Promise<any>) => writes.push(p),
      { remaining: 900 },
    ),
    suffix = manifest
      ? new SuffixReader(manifest, prepare ? suffixRead : suffixSource.read)
      : undefined;
  io.delaysEnabled = suffixIO.delaysEnabled = process.env.CWS_NO_DELAY !== "1";
  const cpu = process.cpuUsage(),
    before = process.memoryUsage(),
    start = performance.now(),
    actual =
      plan === "control"
        ? await engine.search(s.q, reader, s.options)
        : await searchWithSuffix(engine, suffix!, s.q, reader, s.options, {
            bits: plan.startsWith("suffix8") ? 8 : 16,
            rangeMax: plan.endsWith("-max"),
          });
  const body = JSON.stringify(actual),
    wallMs = performance.now() - start,
    usage = process.cpuUsage(cpu),
    after = process.memoryUsage();
  await Promise.all(writes);
  check(actual, s);
  return {
    sid: s.sid,
    q: s.q,
    plan,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1000,
    responseBytes: Buffer.byteLength(body),
    results: actual.results,
    diagnostics: actual.diagnostics,
    suffix: suffix?.stats,
    io: { engine: { ...io.calls }, suffix: { ...suffixIO.calls } },
    memory: { before, after },
    correct: true,
  };
}
const provenance = {
  startedAt,
  generation: root.generation,
  corpusHash: root.corpusHash,
  documents: root.count,
  index,
  suffixGeneration: manifest?.generation,
  code: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  control: "9b4b887",
  model,
  plans,
  repeats,
  exactTotal: false,
  N: 100,
  M: 1000,
  cacheCondition:
    "Empty application and shared caches for every timed request; filesystem/JIT priming is untimed.",
  notes: [
    "Simulated I/O; local process CPU is not Worker CPU.",
    "Suffix and existing index requests share six simulated origin slots.",
    "Complete JSON responses include metadata and snippets.",
    "200 query definitions and expected ranks use the same corpus as the previous 1M run; snippets may select a different valid occurrence.",
  ],
};
await mkdir(dirname(output), { recursive: true });
try {
  storage.prepare = true;
  for (const plan of plans)
    for (const s of scenarios) {
      await query(s, plan, true);
      console.log("Prepared", plan, s.sid);
    }
  storage.prepare = false;
  const preparation = await storage.verify();
  if (process.argv.includes("--prepare-only")) {
    await writeFile(
      output,
      gzipSync(
        JSON.stringify({ ...provenance, preparation, prepareOnly: true }),
      ),
    );
  } else {
    let seed = 879133;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const jobs = Array.from({ length: repeats }, (_, repeat) =>
        scenarios.flatMap((s: any) =>
          plans.map((plan) => ({ s, plan, repeat, order: random() })),
        ),
      )
        .flat()
        .sort((a, b) => a.order - b.order),
      rows: any[] = [];
    for (const job of jobs) {
      const row = {
        ...(await query(job.s, job.plan, false)),
        repeat: job.repeat,
      };
      rows.push(row);
      await writeFile(
        output,
        gzipSync(JSON.stringify({ ...provenance, preparation, rows })),
      );
      console.log(
        rows.length,
        "/",
        jobs.length,
        row.plan,
        row.sid,
        Math.round(row.wallMs) + "ms",
      );
    }
    await writeFile(
      output,
      gzipSync(
        JSON.stringify({
          ...provenance,
          preparation,
          rows,
          completedAt: new Date().toISOString(),
        }),
      ),
    );
  }
} finally {
  await Promise.all([...files.values()].map(async (p) => (await p).close()));
}
