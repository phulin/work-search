import { readFile, writeFile, appendFile, mkdir, open } from "node:fs/promises";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader, type SharedPages } from "../src/global/storage.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { R2Storage } from "../src/storage/r2.js";
import { BinaryIndex } from "../src/format/index.js";
import { openIndex } from "../src/format/paged.js";
import { search } from "../src/query/engine.js";
import { createShard } from "../demo/shard-runtime.js";
import gateway from "../demo/gateway-runtime.js";
import {
  context,
  tracedBucket,
  tracedService,
  type Trace,
} from "./demo-trace.js";
import { EmpiricalModel, Slots, sleep } from "./demo-model.js";
import { demoWorkload } from "./demo-workload.js";
import { globalWarmup } from "./global-workload.js";
const out = "work/global-bench";
await mkdir(out, { recursive: true });
const queries = demoWorkload,
  warmup = globalWarmup
    .slice(0, 8)
    .filter((q: any) => !queries.some((p) => p.q === q.q)),
  calibration = JSON.parse(
    await readFile("work/demo-bench/latency.json", "utf8"),
  ).rows;
const referenceIndex = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  ),
  referenceStorage = new FileStorage(
    "bench/generated/flp-100000/source/objects",
  ),
  expected: Record<string, any> = {};
for (const q of [...queries, ...warmup])
  expected[q.q] = (
    await search(referenceIndex, referenceStorage, q.q, {
      limit: 20,
      metadata: true,
      internalDoc: true,
      executor: "materialized",
    })
  ).results;
await writeFile(out + "/oracle.json", JSON.stringify(expected));
const newManifest = JSON.parse(
    await readFile("work/global-100k/manifest.json", "utf8"),
  ),
  oldCards = JSON.parse(
    await readFile("work/global-baseline/cards.json", "utf8"),
  );
const handles = new Map<string, ReturnType<typeof open>>();
async function fileBytes(
  path: string,
  range?: { offset: number; length: number },
) {
  let file = handles.get(path);
  if (!file) {
    file = open(path, "r");
    handles.set(path, file);
  }
  if (!range) return readFile(path);
  const b = new Uint8Array(range.length),
    r = await (await file).read(b, 0, b.length, range.offset);
  if (r.bytesRead !== b.length) throw Error("Benchmark truncated file " + path);
  return b;
}
interface State extends Trace {
  model: EmpiricalModel;
  slots: Slots;
}
function bucketFor(resolve: (key: string) => string) {
  return {
    get: async (key: string, options?: any) => {
      const t = context.getStore() as State | undefined,
        path = resolve(key),
        bytes = await fileBytes(path, options?.range),
        latency = t?.model.sample(bytes.length) ?? { headersMs: 0, bodyMs: 0 },
        release = await t?.slots.acquire();
      try {
        await sleep(latency.headersMs);
      } finally {
        release?.();
      }
      return {
        customMetadata: { generation: key.split("/")[0] },
        size: bytes.length,
        arrayBuffer: async () => {
          await sleep(latency.bodyMs);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.length,
          );
        },
        get body() {
          let pos = 0;
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              const n = Math.min(65536, bytes.length - pos);
              await sleep((latency.bodyMs * n) / Math.max(1, bytes.length));
              controller.enqueue(bytes.subarray(pos, pos + n));
              pos += n;
              if (pos === bytes.length) controller.close();
            },
          });
        },
      };
    },
  } as unknown as R2Bucket;
}
function validate(q: string, results: any[]) {
  const want = expected[q];
  if (
    results.length !== want.length ||
    results.some(
      (h, i) =>
        h.id !== want[i].id ||
        Math.abs(h.score - want[i].score) >
          1e-11 * Math.max(1, Math.abs(want[i].score)),
    )
  )
    throw Error("Global/old ranking mismatch " + q);
  for (let i = 0; i < results.length; i++)
    if (
      JSON.stringify([results[i].title, results[i].metadata]) !==
      JSON.stringify([want[i].title, want[i].metadata])
    )
      throw Error("Global/old record mismatch " + q);
}
const rows: any[] = [];
const label = process.env.GLOBAL_BENCH_LABEL ?? "local";
await writeFile(out + "/" + label + ".jsonl", "");
async function record(
  config: any,
  phase: string,
  pass: number,
  qi: number,
  q: any,
  run: () => Promise<any>,
  timed = true,
) {
  const trace: State = {
      start: performance.now(),
      events: [],
      model: new EmpiricalModel(
        calibration,
        20261112 + qi + pass * 4099,
        "empirical",
        "varied-range",
      ),
      slots: new Slots(6),
    },
    cpu = process.cpuUsage(),
    start = performance.now();
  const response = await context.run(trace, run),
    ms = performance.now() - start;
  validate(q.q, response.results);
  if (timed) {
    const used = process.cpuUsage(cpu),
      events = trace.events.filter((e) => e.type === "r2"),
      r = {
        ...config,
        phase,
        pass,
        q: q.q,
        kind: q.kind,
        ms,
        cpuMs: (used.user + used.system) / 1000,
        rss: process.memoryUsage().rss,
        requests: events.length,
        bytes: events.reduce((n, e) => n + (e.bytes ?? 0), 0),
        requestedBytes: events.reduce(
          (n, e) => n + (e.length ?? e.bytes ?? 0),
          0,
        ),
        diagnostics: response.diagnostics,
        results: response.results.map((h: any) => ({
          id: h.id,
          score: h.score,
        })),
      };
    rows.push(r);
    await appendFile(out + "/" + label + ".jsonl", JSON.stringify(r) + "\n");
    console.log(
      config.engine,
      config.budget,
      config.pageKiB,
      phase,
      pass,
      q.q,
      Math.round(ms),
    );
  }
  return response;
}
const only = process.env.GLOBAL_BENCH_ONLY;
for (const budget of (process.env.GLOBAL_BENCH_BUDGETS ?? "8,16,32,48")
  .split(",")
  .map(Number)) {
  if (only !== "global") {
    const oldDir = `bench/generated/flp-100000/opt6-${budget}`,
      binary = await readFile(oldDir + "/bundle.bin"),
      index = openIndex(binary),
      cards = oldCards[budget],
      runtime = new SearchRuntime(4 * 1048576);
    const baseBucket = bucketFor((key) => {
      const [generation, name] = key.split("/");
      if (generation === cards.cardGeneration)
        return `work/global-baseline/cards-${budget}/` + name;
      if (name === "cardroot-0.bin")
        return `work/global-baseline/cards-${budget}/cardroot-0.bin`;
      if (name.startsWith("content"))
        return "work/global-baseline/viewer/" + name;
      return oldDir + "/objects/" + key;
    });
    const leaf = createShard(binary, runtime),
      leafEnv = {
        INDEX: tracedBucket(baseBucket),
        INTERNAL_TOKEN: "test",
        SHARD_ID: "0",
      },
      service = {
        fetch: (url: string, init: RequestInit) =>
          leaf.fetch(new Request(url, init), leafEnv),
      },
      env: any = {
        INDEX: tracedBucket(baseBucket),
        INTERNAL_TOKEN: "test",
        ROLE: "root",
        PERF_LEVEL: "3",
        CHILDREN: JSON.stringify([{ binding: "PART", min: 0, max: 0 }]),
        PART: tracedService(service as any, "leaf"),
      };
    const run = async (q: string) => {
      const r = await gateway.fetch(
        new Request("https://old/api/search", {
          method: "POST",
          body: JSON.stringify({ q, limit: 20 }),
        }),
        env,
      );
      const v: any = await r.json();
      if (!r.ok) throw Error(JSON.stringify(v));
      return v;
    };
    for (const phase of (process.env.GLOBAL_BENCH_PHASES ?? "novel").split(
      ",",
    )) {
      runtime.clear();
      env.INDEX = tracedBucket(new Proxy(baseBucket, {}));
      if (phase !== "cold")
        for (const [i, q] of warmup.entries())
          await record(
            { engine: "old", budget },
            phase,
            -1,
            i,
            q,
            () => run(q.q),
            false,
          );
      for (let pass = 0; pass < (phase === "repeat" ? 2 : 1); pass++)
        for (const [i, q] of queries.entries()) {
          if (phase === "cold") {
            runtime.clear();
            env.INDEX = tracedBucket(new Proxy(baseBucket, {}));
          }
          await record({ engine: "old", budget }, phase, pass, i, q, () =>
            run(q.q),
          );
        }
    }
  }
  if (only !== "old")
    for (const pageKiB of (process.env.GLOBAL_BENCH_PAGES ?? "64,128,256")
      .split(",")
      .map(Number)) {
      const index = new GlobalIndex(
          await readFile(
            `work/global-100k/${process.env.GLOBAL_HEADS === "1" ? "bundle-heads" : "bundle"}-${budget}.bin`,
          ),
        ),
        memory = new SearchRuntime(8 * 1048576),
        shared = new Map<string, Uint8Array>(),
        cache: SharedPages = {
          async get(key) {
            await sleep(1);
            return shared.get(key);
          },
          async put(key, b) {
            await sleep(1);
            shared.set(key, b);
          },
        },
        pending: Promise<unknown>[] = [];
      const bucket = tracedBucket(
          bucketFor((key) => "work/global-100k/packs/" + key.split("/").at(-1)),
        ),
        pageRoot = {
          ...index.root,
          pageBytes: pageKiB * 1024,
          objectPages: (64 * 1048576) / (pageKiB * 1024),
        };
      const run = async (q: string) =>
        index.search(
          new PageReader(
            pageRoot,
            new R2Storage(bucket, index.root.generation),
            memory,
            cache,
            (p) => pending.push(p),
            true,
            process.env.GLOBAL_CACHE_POLICY === "adaptive960"
              ? "adaptive960"
              : "fixed384",
          ),
          q,
        );
      for (const phase of (process.env.GLOBAL_BENCH_PHASES ?? "novel").split(
        ",",
      )) {
        memory.clear();
        shared.clear();
        if (phase !== "cold")
          for (const [i, q] of warmup.entries()) {
            await record(
              { engine: "global", budget, pageKiB },
              phase,
              -1,
              i,
              q,
              () => run(q.q),
              false,
            );
            await Promise.all(pending.splice(0));
          }
        for (let pass = 0; pass < (phase === "repeat" ? 2 : 1); pass++)
          for (const [i, q] of queries.entries()) {
            if (phase === "cold") {
              memory.clear();
              shared.clear();
            }
            await record(
              { engine: "global", budget, pageKiB },
              phase,
              pass,
              i,
              q,
              () => run(q.q),
            );
            await Promise.all(pending.splice(0));
          }
      }
    }
}
await writeFile(
  out + "/" + label + ".json",
  JSON.stringify({
    kind: "Local full-response current paged engine versus global term-oriented engine; calibrated varied-range R2 headers/body, six header slots, shared-cache latency assumed 1ms; source corpus 100k FLP; no response cache",
    build: newManifest,
    rows,
  }),
);
for (const h of handles.values()) await (await h).close();
