import { Session } from "node:inspector";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { SimulatedIO } from "./latency-model.js";
const [dir, pairDir, contractsFile, out] = process.argv.slice(2);
if (!out)
  throw Error("Usage: profile-warm-cpu.ts INDEX PAIRS CONTRACTS OUTPUT");
const base = process.env.CWS_PROFILE_SOURCE ?? ".",
  { LocalObjects } = await import(
    pathToFileURL(resolve(base, "bench/columnar/local-storage.ts")).href
  ),
  module = (file: string) =>
    import(
      pathToFileURL(
        resolve(
          base,
          process.env.CWS_PROFILE_COMPILED
            ? "columnar/" + file + ".js"
            : "src/columnar/" + file + ".ts",
        ),
      ).href
    ),
  [
    { ColumnarIndex },
    { Reader, Memory, Lru },
    { TermDirectory },
    { DocumentDirectory },
    { PairRouter },
  ] = await Promise.all(
    [
      "search",
      "storage",
      "term-directory",
      "document-directory",
      "pair-router",
    ].map(module),
  );
await mkdir(out, { recursive: true });
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  td = await readFile(dir + "/directory.bin"),
  dd = await readFile(dir + "/documents.bin"),
  router = new PairRouter(await readFile(pairDir + "/router.bin")),
  presence = JSON.parse(await readFile(pairDir + "/presence.json", "utf8")),
  contract = JSON.parse(await readFile(contractsFile, "utf8"));
const chosen = new Set([
  '(jurisdiction OR "summary judgment") AND NOT "res ipsa loquitur"',
  "summary judgment",
  "(of OR the) AND limit",
  'court OR the OR of OR "and"',
]);
const source = new LocalObjects(
  root,
  process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
);
source.namedDirectory = pairDir;
const memory = new Memory();
memory.pages = new Lru(12 * 1048576);
const index = new ColumnarIndex(
    root,
    undefined,
    new TermDirectory(td, root.count),
    undefined,
    new DocumentDirectory(dd),
    { router, N: 100, M: 1000, presence },
  ),
  io = new SimulatedIO(
    source,
    {
      r2Ms: 0,
      sharedMs: 0,
      r2MiBPerSecond: 100,
      sharedMiBPerSecond: 1000,
      jitterMs: 0,
      seed: 1,
    },
    1024,
  );
io.delaysEnabled = false;
const session = new Session();
session.connect();
const post = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((res, rej) =>
    session.post(method as any, params, (e, r) => (e ? rej(e) : res(r))),
  );
const rows = [];
for (const [sid, s] of contract.scenarios.entries()) {
  if (
    process.env.CWS_QUERY_FILTER
      ? !process.env.CWS_QUERY_FILTER.split("|").some((q) => s.q.includes(q))
      : !chosen.has(s.q)
  )
    continue;
  const run = async () => {
    const deferred: Promise<unknown>[] = [],
      reader = new Reader(
        root,
        io.source,
        memory,
        io.shared,
        "profile",
        (p: Promise<unknown>) => deferred.push(p),
      ),
      cpu = process.cpuUsage(),
      start = performance.now(),
      result = await index.search(s.q, reader, s.options),
      body = JSON.stringify(result),
      wallMs = performance.now() - start,
      usage = process.cpuUsage(cpu);
    await Promise.all(deferred);
    if (
      result.results.length !== s.oracle.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== s.oracle[i].id ||
          Math.abs(h.score - s.oracle[i].score) >
            1e-11 * Math.max(1, Math.abs(s.oracle[i].score)),
      )
    )
      throw Error("Oracle mismatch: " + s.q);
    return {
      wallMs,
      cpuMs: (usage.user + usage.system) / 1000,
      responseBytes: body.length,
      diagnostics: result.diagnostics,
    };
  };
  for (let i = 0; i < 3; i++) await run();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  const calls = [];
  for (let i = 0; i < 8; i++) calls.push(await run());
  const { profile } = await post("Profiler.stop");
  await writeFile(
    out + "/" + sid + ".cpuprofile.gz",
    gzipSync(JSON.stringify(profile)),
  );
  await post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < 3; i++) await run();
  const { profile: heap } = await post("HeapProfiler.stopSampling");
  await writeFile(
    out + "/" + sid + ".heapprofile.gz",
    gzipSync(JSON.stringify(heap)),
  );
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n])),
    parents = new Map<number, number>();
  for (const n of profile.nodes)
    for (const id of n.children ?? []) parents.set(id, n.id);
  const self = new Map<string, number>(),
    inclusive = new Map<string, number>(),
    key = (n: any) =>
      n.callFrame.functionName +
      ":" +
      n.callFrame.url.split("/").slice(-2).join("/") +
      ":" +
      (n.callFrame.lineNumber + 1);
  profile.samples.forEach((id: number, i: number) => {
    const us = profile.timeDeltas[i];
    self.set(key(nodes.get(id)), (self.get(key(nodes.get(id))) ?? 0) + us);
    for (let p: number | undefined = id; p !== undefined; p = parents.get(p)) {
      const k = key(nodes.get(p));
      inclusive.set(k, (inclusive.get(k) ?? 0) + us);
    }
  });
  const alloc = new Map<string, number>();
  function walk(n: any) {
    const k = key(n);
    alloc.set(k, (alloc.get(k) ?? 0) + n.selfSize);
    for (const c of n.children ?? []) walk(c);
  }
  walk(heap.head);
  const sorted = (m: Map<string, number>) =>
    Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
  const row = {
    q: s.q,
    options: s.options,
    sid,
    calls,
    selfMicros: sorted(self),
    inclusiveMicros: sorted(inclusive),
    sampledAllocationBytes: sorted(alloc),
    processMemory: process.memoryUsage(),
  };
  rows.push(row);
  console.log(
    s.q,
    "CPU self",
    Object.entries(row.selfMicros).slice(0, 15),
    "alloc",
    Object.entries(row.sampledAllocationBytes).slice(0, 12),
  );
}
session.disconnect();
await writeFile(
  out + "/summary.json",
  JSON.stringify(
    {
      kind: "Local Node CPU/sampled allocation attribution; no artificial delays; not live Worker latency or retained/peak memory",
      source: base,
      searchSha256: createHash("sha256")
        .update(
          await readFile(
            resolve(
              base,
              process.env.CWS_PROFILE_COMPILED
                ? "columnar/search.js"
                : "src/columnar/search.ts",
            ),
          ),
        )
        .digest("hex"),
      maxscoreSha256: createHash("sha256")
        .update(
          await readFile(
            resolve(
              base,
              process.env.CWS_PROFILE_COMPILED
                ? "columnar/maxscore.js"
                : "src/columnar/maxscore.ts",
            ),
          ),
        )
        .digest("hex"),
      storageSha256: createHash("sha256")
        .update(
          await readFile(
            resolve(
              base,
              process.env.CWS_PROFILE_COMPILED
                ? "columnar/storage.js"
                : "src/columnar/storage.ts",
            ),
          ),
        )
        .digest("hex"),
      kernelSha256: await readFile(
        resolve(
          base,
          process.env.CWS_PROFILE_COMPILED
            ? "columnar/score-scan.js"
            : "src/columnar/score-scan.ts",
        ),
      )
        .then((raw) => createHash("sha256").update(raw).digest("hex"))
        .catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        }),
      generation: root.generation,
      downloads: source.downloads,
      rows,
    },
    null,
    2,
  ),
);
