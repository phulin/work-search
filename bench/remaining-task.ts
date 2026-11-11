import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { search as baseline } from "./baseline-remaining/engine.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { connectorQueries } from "./connector-queries.js";
const [n, budget] = process.argv.slice(2),
  name = `${n}-${budget}`;
const plain = (await readFile("bench/generated/queries.txt", "utf8"))
  .split("\n")
  .filter(Boolean);
const heldout = [
  "category7 word12345",
  "(word19999 OR word19998) AND document",
  "(word19999 OR word19998) /s engine",
  "word12345 /5 search",
  '"document search"',
  "document OR word0",
  "word10 AND NOT category7",
  "(word10 OR word20) /p category7",
];
async function open(root: string) {
  const manifest = JSON.parse(await readFile(root + "/manifest.json", "utf8"));
  const bytes = await readFile(root + "/bundle.bin");
  if (
    createHash("sha256").update(bytes).digest("hex") !== manifest.bundleSha256
  )
    throw new Error("Bundle hash mismatch");
  return {
    index: new BinaryIndex(bytes),
    store: new FileStorage(root + "/objects"),
    manifest,
  };
}
const original = await open(`bench/generated/${name}-workload`),
  frequency = await open(`bench/generated/remaining-${name}-frequency`),
  mixed = await open(`bench/generated/remaining-${name}-mixed`);
if (
  frequency.manifest.bundleBytes > Number(budget) * 1048576 ||
  mixed.manifest.bundleBytes > Number(budget) * 1048576
)
  throw new Error("Budget exceeded");
const samples: any[] = [];
type Result =
  Awaited<ReturnType<typeof search>> | Awaited<ReturnType<typeof baseline>>;
async function run(fn: () => Promise<Result>) {
  const start = performance.now(),
    cpu = process.cpuUsage(),
    r = await fn(),
    used = process.cpuUsage(cpu);
  return {
    r,
    ms: performance.now() - start,
    cpuMs: (used.user + used.system) / 1000,
  };
}
function same(a: Result, b: Result, totals = true) {
  if (
    JSON.stringify(a.results) !== JSON.stringify(b.results) ||
    (totals && a.total !== b.total)
  )
    throw new Error("Exact results differ");
}
function record(
  suite: string,
  q: string,
  variant: string,
  x: Awaited<ReturnType<typeof run>>,
  pass: number,
) {
  samples.push({
    suite,
    q,
    variant,
    pass,
    ms: x.ms,
    cpuMs: x.cpuMs,
    ...x.r.diagnostics,
    total: x.r.total,
    resultHash: createHash("sha256")
      .update(JSON.stringify(x.r.results))
      .digest("hex"),
  });
}
// Both policies train on exactly the same mixed workload. Held-out queries are
// disjoint from that file and remain reported separately.
for (const [suite, queries] of [
  ["embedding-plain", plain],
  ["embedding-connectors", connectorQueries],
  ["embedding-heldout", heldout],
] as const) {
  for (let pass = 0; pass < 3; pass++)
    for (const q of queries) {
      const f = () => search(frequency.index, frequency.store, q),
        m = () => search(mixed.index, mixed.store, q);
      const [x, y] =
          pass % 2
            ? [await run(m), await run(f)]
            : [await run(f), await run(m)],
        a = pass % 2 ? y : x,
        b = pass % 2 ? x : y;
      same(a.r, b.r);
      record(suite, q, "frequency-first", a, pass);
      record(suite, q, "joint", b, pass);
    }
}
const planning = [
  "word19999 document",
  "word19999 /s engine",
  "(word19999 OR word19998) AND document",
  "(word19999 OR word19998) /s engine",
  "category1 /p word0",
  'word10 AND NOT "word20 category1"',
];
for (let pass = 0; pass < 3; pass++)
  for (const q of planning) {
    const a = () => baseline(original.index, original.store, q),
      b = () => search(original.index, original.store, q);
    const [x, y] =
        pass % 2 ? [await run(b), await run(a)] : [await run(a), await run(b)],
      before = pass % 2 ? y : x,
      after = pass % 2 ? x : y;
    same(before.r, after.r);
    record("planning", q, "previous", before, pass);
    record("planning", q, "adaptive", after, pass);
  }
for (const q of [
  "document",
  "search OR engine",
  "word0 OR document",
  "category1 OR word0",
]) {
  const oracle = await run(() => search(original.index, original.store, q));
  record("pruning", q, "exact-total", oracle, 0);
  const runtime = new SearchRuntime(4 * 1048576);
  for (let pass = 0; pass < 4; pass++) {
    const x = await run(() =>
      search(original.index, original.store, q, { runtime, exactTotal: false }),
    );
    same(oracle.r, x.r, false);
    if ("total" in x.r) throw new Error("Pruned search claimed an exact total");
    record("pruning", q, pass === 0 ? "cold" : "warm", x, pass);
  }
}
for (const q of [
  "category1",
  "word19999",
  "word10 /s word20",
  "(word10 OR word20) AND category1",
]) {
  const runtime = new SearchRuntime(4 * 1048576),
    oracle = await run(() => search(original.index, original.store, q));
  record("cache", q, "uncached", oracle, 0);
  for (let pass = 0; pass < 4; pass++) {
    const x = await run(() =>
      search(original.index, original.store, q, { runtime }),
    );
    same(oracle.r, x.r);
    record("cache", q, pass === 0 ? "cold" : "warm", x, pass);
    if (runtime.bytes > runtime.capacity) throw new Error("Cache overflow");
  }
}
// Repacking must preserve the separate metadata objects too.
same(
  await search(original.index, original.store, "word19999", { metadata: true }),
  await search(mixed.index, mixed.store, "word19999", { metadata: true }),
);
await writeFile(
  `bench/results/remaining-${name}.json`,
  JSON.stringify(
    {
      name,
      documents: Number(n),
      budgetMiB: Number(budget),
      format: 5,
      environment:
        "local Node search/filesystem; not deployed Cloudflare latency; query-only child process",
      frequencyBundleBytes: frequency.manifest.bundleBytes,
      mixedBundleBytes: mixed.manifest.bundleBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      samples,
    },
    null,
    2,
  ),
);
console.log(
  name + " all ablations match exact IDs/scores/counts (pruned counts omitted)",
);
