import { Session } from "node:inspector";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { Reader, Memory } from "../../src/columnar/storage.js";
import { PairRouter } from "../../src/columnar/pair-router.js";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";
const [dir, pairDir, out] = process.argv.slice(2);
if (!dir || !pairDir || !out)
  throw Error("Usage: local-pair-profile.ts INDEX PAIRS OUTPUT");
await mkdir(out, { recursive: true });
const root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  td = await readFile(dir + "/directory.bin"),
  dd = await readFile(dir + "/documents.bin"),
  router = new PairRouter(await readFile(pairDir + "/router.bin")),
  presence = JSON.parse(await readFile(pairDir + "/presence.json", "utf8")),
  contracts = JSON.parse(
    await readFile("work/columnar-bench/pair-pilot-contract-1m.json", "utf8"),
  ).scenarios.filter(
    (s: any) =>
      s.q === "the pennsylvania" ||
      (s.q === '"burden of proving"' && s.options?.field === "body") ||
      (s.q === '"in the absence of"' && !s.options?.field),
  ),
  source = new LocalObjects(
    root,
    process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
  );
source.namedDirectory = pairDir;
const session = new Session();
session.connect();
const post = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) =>
    session.post(method as any, params, (e, r) => (e ? reject(e) : resolve(r))),
  );
const rows = [];
for (const enabled of [false, true]) {
  const memory = new Memory(),
    directory = new TermDirectory(td, root.count),
    documents = new DocumentDirectory(dd),
    index = new ColumnarIndex(
      root,
      undefined,
      directory,
      undefined,
      documents,
      enabled ? { router, N: 100, M: 1000, presence } : undefined,
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
  for (const [qi, s] of contracts.entries()) {
    const run = async () => {
      const deferred: Promise<unknown>[] = [],
        reader = new Reader(
          root,
          io.source,
          memory,
          io.shared,
          "profile",
          (p) => deferred.push(p),
        ),
        started = performance.now(),
        cpu = process.cpuUsage();
      const result = await index.search(s.q, reader, s.options),
        json = JSON.stringify(result),
        usage = process.cpuUsage(cpu);
      const wallMs = performance.now() - started;
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
        throw Error("Oracle mismatch");
      return {
        wallMs,
        cpuMs: (usage.user + usage.system) / 1000,
        bytes: json.length,
        diagnostics: result.diagnostics,
      };
    };
    await run();
    await run();
    const prefix = (enabled ? "membership" : "no-membership") + "-" + qi;
    await post("Profiler.enable");
    await post("Profiler.start");
    const calls = [];
    for (let i = 0; i < 5; i++) calls.push(await run());
    const { profile } = await post("Profiler.stop");
    await writeFile(
      out + "/" + prefix + ".cpuprofile.gz",
      gzipSync(JSON.stringify(profile)),
    );
    await post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < 2; i++) await run();
    const { profile: heap } = await post("HeapProfiler.stopSampling");
    await writeFile(
      out + "/" + prefix + ".heapprofile.gz",
      gzipSync(JSON.stringify(heap)),
    );
    const nodes = new Map<number, any>(
        profile.nodes.map((n: any) => [n.id, n]),
      ),
      self = new Map<string, number>();
    profile.samples.forEach((id: number, i: number) => {
      const f = nodes.get(id).callFrame,
        key = `${f.functionName}:${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i]);
    });
    const allocation = new Map<string, number>();
    const walk = (n: any) => {
      const f = n.callFrame,
        key = `${f.functionName}:${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
      allocation.set(key, (allocation.get(key) ?? 0) + n.selfSize);
      for (const c of n.children ?? []) walk(c);
    };
    walk(heap.head);
    const row = {
      variant: enabled ? "membership" : "no-membership",
      q: s.q,
      options: s.options,
      calls,
      selfMicros: Object.fromEntries([...self].sort((a, b) => b[1] - a[1])),
      sampledAllocationBytes: Object.fromEntries(
        [...allocation].sort((a, b) => b[1] - a[1]),
      ),
      processMemory: process.memoryUsage(),
    };
    rows.push(row);
    console.log(
      row.variant,
      s.q,
      s.options,
      [...self].sort((a, b) => b[1] - a[1]).slice(0, 8),
    );
  }
}
session.disconnect();
await writeFile(
  out + "/summary.json",
  JSON.stringify(
    {
      kind: "Local Node attribution, artificial delays disabled; not native latency or memory evidence",
      generation: root.generation,
      rows,
    },
    null,
    2,
  ),
);
