import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { search as reference } from "./baseline-next.js";
import { SearchRuntime } from "../src/query/runtime.js";
const [budget, policy] = process.argv.slice(2),
  root = `bench/generated/flp/${budget}-${policy}`;
const m = JSON.parse(await readFile(root + "/manifest.json", "utf8")),
  bytes = await readFile(root + "/bundle.bin");
if (
  bytes.length > Number(budget) * 1048576 ||
  createHash("sha256").update(bytes).digest("hex") !== m.bundleSha256
)
  throw Error("Invalid fixture");
const startup = performance.now(),
  index = new BinaryIndex(bytes),
  indexConstructionMs = performance.now() - startup,
  storage = new FileStorage(root + "/objects");
const { test: queries } = JSON.parse(
  await readFile("bench/generated/flp/queries.json", "utf8"),
) as { test: { q: string; kind: string }[] };
let seed = 20261111;
function rand() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
function shuffled<T>(a: T[]) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
const expected = new Map<
  string,
  { results: unknown; total: number | undefined }
>();
for (const query of queries) {
  const r = await reference(index, storage, query.q, { exactTotal: true });
  expected.set(query.q, { results: r.results, total: r.total });
}
const samples: any[] = [];
async function run(
  query: (typeof queries)[number],
  variant: string,
  phase: string,
  pass: number,
  runtime?: SearchRuntime,
) {
  const cpu = process.cpuUsage(),
    start = performance.now();
  let result: Awaited<ReturnType<typeof search>> | undefined,
    error: string | undefined;
  try {
    result = await search(index, storage, query.q, {
      optimizationStage: variant === "baseline" ? 0 : 7,
      runtime,
    });
  } catch (e) {
    error = String(e);
  }
  const ms = performance.now() - start,
    used = process.cpuUsage(cpu);
  // All validation, JSON serialization and memory sampling are outside timing.
  if (
    result &&
    JSON.stringify(result.results) !==
      JSON.stringify(expected.get(query.q)!.results)
  )
    throw Error(`Results differ: ${query.q}/${variant}`);
  samples.push({
    q: query.q,
    kind: query.kind,
    variant,
    phase,
    pass,
    ms,
    cpuMs: (used.user + used.system) / 1000,
    error,
    matches: expected.get(query.q)!.total,
    resultHash: result
      ? createHash("sha256")
          .update(JSON.stringify(result.results))
          .digest("hex")
      : undefined,
    diagnostics: result?.diagnostics,
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
  });
}
// Pair variants per query, randomize their order, no retained runtime cache.
for (let pass = 0; pass < 3; pass++)
  for (const q of shuffled(queries))
    for (const variant of shuffled(["baseline", "optimized"]))
      await run(q, variant, "uncached", pass);
// A shared 4 MiB cache per variant sees a mixed, shuffled stream rather than
// immediate repetitions. Separate pass 0 from the later passes.
const runtimes = {
  baseline: new SearchRuntime(),
  optimized: new SearchRuntime(),
};
for (let pass = 0; pass < 3; pass++)
  for (const q of shuffled(queries))
    for (const variant of shuffled(["baseline", "optimized"] as const))
      await run(q, variant, "mixed-cache", pass, runtimes[variant]);
const entries = Array.from({ length: index.termCount }, (_, i) =>
  index.entry(i),
);
await writeFile(
  `bench/results/flp-${budget}-${policy}.json`,
  JSON.stringify(
    {
      budgetMiB: Number(budget),
      policy,
      description:
        "Local filesystem; same v8 bytes, execution stages 0 and 7; randomized paired variants, disjoint workload; uncached vs mixed-query LRU; correctness outside timer",
      indexConstructionMs,
      documents: index.count,
      vocabulary: index.termCount,
      mandatoryBytes: index.local,
      dictionaryBytes: index.docs,
      bundleBytes: bytes.length,
      frequencyBytes: entries.reduce((s, e) => s + e.length, 0),
      positionBytes: entries.reduce((s, e) => s + e.positionLength, 0),
      totalStoredBytes:
        bytes.length + m.objects.reduce((s: number, o: any) => s + o.size, 0),
      peakProcessRss: process.resourceUsage().maxRSS * 1024,
      samples,
    },
    null,
    2,
  ),
);
console.log(
  `${budget}/${policy}: ${samples.length} measured searches, ${samples.filter((s) => s.error).length} errors`,
);
