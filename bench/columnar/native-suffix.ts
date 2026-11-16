import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import "../../scripts/workerd-runtime.js";
import { loadServingAssets } from "../../scripts/columnar-serving.js";
import { RangeStorage } from "./range-storage.js";
import { SimulatedIO } from "./latency-model.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { Semaphore } from "../../src/columnar/storage.js";

const [indexInput, suffixInput, outputInput] = process.argv.slice(2);
if (!outputInput)
  throw Error("Use INDEX_DIRECTORY SUFFIX_DIRECTORY OUTPUT_DIRECTORY");
const index = resolve(indexInput),
  suffixDir = resolve(suffixInput),
  out = resolve(outputInput),
  assets = await loadServingAssets(index),
  controlCommit = execFileSync(
    "git",
    ["rev-parse", process.env.CWS_CONTROL_COMMIT ?? "21ff91a"],
    { encoding: "utf8" },
  ).trim(),
  frozenRoot = resolve("work/suffix-control-" + controlCommit),
  manifest = JSON.parse(
    await readFile(
      suffixDir +
        "/" +
        (process.env.CWS_SUFFIX_MANIFEST ?? "manifest-fences.json"),
      "utf8",
    ),
  ),
  contract = JSON.parse(
    gunzipSync(
      await readFile(
        process.env.CWS_CONTRACT_PATH ?? "work/suffix-30-contract.json.gz",
      ),
    ).toString(),
  ),
  selected: number[] = process.env.CWS_QUERY_IDS
    ? process.env.CWS_QUERY_IDS.split(",").map(Number)
    : contract.scenarios.map((_: unknown, i: number) => i),
  modes = (process.env.CWS_NATIVE_PLANS ?? "control,suffix").split(","),
  concurrency = Number(process.env.CWS_NATIVE_CONCURRENCY ?? 1),
  memoryProfile = process.env.CWS_NATIVE_MEMORY_PROFILE === "1",
  storage = new RangeStorage(assets.root, index + "/local-ranges"),
  model = {
    r2Ms: 20,
    r2MiBPerSecond: 100,
    sharedMs: 2,
    sharedMiBPerSecond: 1000,
    jitterMs: 0,
    seed: 879133,
  },
  jobs = new Map<string, any>(),
  handles = new Map<string, ReturnType<typeof open>>();
if (
  modes.some((m) => m !== "control" && m !== "suffix") ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 16
)
  throw Error("Invalid native benchmark plans or concurrency");
await mkdir(frozenRoot, { recursive: true });
if (
  !(await readFile(frozenRoot + "/src/columnar/search.ts").then(
    () => true,
    () => false,
  ))
)
  execFileSync("tar", ["-x", "-C", frozenRoot], {
    input: execFileSync("git", ["archive", controlCommit, "src"], {
      maxBuffer: 32 * 1048576,
    }),
  });
await mkdir(out, { recursive: true });
storage.include(
  [...new DocumentDirectory(assets.documents!).groups()].map((g) => ({
    key: g.key,
    size: g.bytes,
    sha256: g.key.split("/")[0],
  })),
);
console.log("Verifying local data");
await storage.verify();
console.log("Verified");
const suffixRead = async (file: string, offset: number, length: number) => {
  let pending = handles.get(file);
  if (!pending)
    handles.set(file, (pending = open(suffixDir + "/" + file, "r")));
  const raw = Buffer.allocUnsafe(length);
  if ((await (await pending).read(raw, 0, length, offset)).bytesRead !== length)
    throw Error("Truncated suffix column");
  return raw;
};
const data: Record<string, Uint8Array> = {
  "directory.bin": assets.directory!,
  "documents.bin": assets.documents!,
  ...(assets.router ? { "router.bin": assets.router } : {}),
  ...(assets.exactPhrases ? { "exact.bin": assets.exactPhrases } : {}),
  "suffix-fences.bin": await readFile(
    suffixDir + "/" + (manifest.fences ?? "fences"),
  ),
  "suffix-intervals.bin": await readFile(suffixDir + "/intervals"),
  "suffix-ranks.bin": await readFile(suffixDir + "/" + manifest.phraseRanks),
  ...(manifest.phraseRankIndex
    ? {
        "suffix-rank-index.bin": await readFile(
          suffixDir + "/" + manifest.phraseRankIndex,
        ),
      }
    : {}),
  ...(manifest.numericPackets
    ? {
        "suffix-numeric-index.bin": await readFile(
          suffixDir + "/" + manifest.numericPackets.index,
        ),
      }
    : {}),
};
async function connect(mf: Miniflare) {
  const u = new URL(await mf.getInspectorURL());
  u.protocol = "http:";
  const targets: any = await fetch(new URL("/json/list", u)).then((r) =>
      r.json(),
    ),
    ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise<void>((ok, no) => {
    ws.addEventListener("open", () => ok(), { once: true });
    ws.addEventListener("error", () => no(Error("Inspector failed")), {
      once: true,
    });
  });
  let next = 0;
  const waiting = new Map<number, any>();
  ws.addEventListener("message", (e) => {
    const r = JSON.parse(String(e.data)),
      p = waiting.get(r.id);
    if (!p) return;
    waiting.delete(r.id);
    clearTimeout(p.timer);
    r.error ? p.no(Error(JSON.stringify(r.error))) : p.ok(r.result);
  });
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((ok, no) => {
      const id = ++next,
        timer = setTimeout(() => {
          waiting.delete(id);
          no(Error("Inspector timeout " + method));
        }, 10000);
      waiting.set(id, { ok, no, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}
async function worker(mode: string) {
  const frozen = mode === "control",
    source = resolve(frozen ? frozenRoot + "/src" : "src"),
    moduleRoot = out + "/" + mode,
    moduleData = Object.fromEntries(
      Object.entries(data).filter(([n]) => !frozen || !n.startsWith("suffix-")),
    ),
    imports = Object.keys(moduleData)
      .map((n, i) => `import b${i} from './${n}';`)
      .join(""),
    variable = (name: string) =>
      `new Uint8Array(b${Object.keys(moduleData).indexOf(name)})`,
    entry = `${imports}
 import {ColumnarIndex} from ${JSON.stringify(source + "/columnar/search.ts")};
 import {TermDirectory} from ${JSON.stringify(source + "/columnar/term-directory.ts")};
 import {DocumentDirectory} from ${JSON.stringify(source + "/columnar/document-directory.ts")};
 import {PairRouter} from ${JSON.stringify(source + "/columnar/pair-router.ts")};
 import {ExactPhraseDirectory} from ${JSON.stringify(source + "/columnar/exact-phrase-directory.ts")};
 import {Reader,Memory,Lru} from ${JSON.stringify(source + "/columnar/storage.ts")};
 ${!frozen ? `import {SuffixReader,SuffixMemory} from ${JSON.stringify(resolve("src/suffix/reader.ts"))};import {searchWithSuffix} from ${JSON.stringify(resolve("src/suffix/search.ts"))};` : ""}
 let isolateId;
 const root=${JSON.stringify(assets.root)}, manifest=${JSON.stringify(manifest)}, documents=new DocumentDirectory(${variable("documents.bin")}),
 settings={router:new PairRouter(${variable("router.bin")}),exactPhrases:new ExactPhraseDirectory(${variable("exact.bin")}),presence:${JSON.stringify(assets.membership?.presence)},N:100,M:1000};
 const pages=new Lru(12*1048576),decoded=new Lru(4*1048576)${!frozen ? ",suffixMemory=new SuffixMemory(manifest.generation)" : ""};
 const scoped=(cache,namespace)=>({get:key=>cache.get(namespace+':'+key),set:(key,value,bytes)=>cache.set(namespace+':'+key,value,bytes),entries:{has:key=>cache.entries.has(namespace+':'+key)},get limit(){return cache.limit;},get bytes(){return cache.bytes;},get peak(){return cache.peak;}});
 export default {async fetch(request,env){
 isolateId??=crypto.randomUUID();
 if(new URL(request.url).pathname==='/__gc') {const available=typeof globalThis.gc==='function';if(available)globalThis.gc();return Response.json({available});}
 const directory=new TermDirectory(${variable("directory.bin")},root.count),engine=new ColumnarIndex(root,undefined,directory,undefined,documents,settings);
 const input=await request.json(), run=input.runId;
 const invoke=async(op,key,offset=0,length=0,range=undefined,body=undefined)=>{
 const r=await env.DATA.fetch('http://data/',{method:body?'POST':'GET',headers:{run,op,key,offset:String(offset),length:String(length),range:JSON.stringify(range??null)},body});
 if(!r.ok)throw Error(await r.text());return r;
 }, read=async(op,key,offset,length)=>(new Uint8Array(await (await invoke(op,key,offset,length)).arrayBuffer())),
 source={read:(key,offset,length)=>read('read',key,offset,length),readPage:async(key,offset,length)=>({data:await read('read',key,offset,length)}),
 readNamed:(key,length)=>read('named',key,0,length),readWhole:async(key,range)=>{const r=await invoke('whole',key,0,0,range);return {data:new Uint8Array(await r.arrayBuffer()),sha256:r.headers.get('sha256')??undefined};}},
 shared={get:async key=>{const r=await invoke('sharedGet',key);return r.headers.get('hit')==='1'?new Uint8Array(await r.arrayBuffer()):undefined;},put:async(key,bytes)=>{await invoke('sharedPut',key,0,0,undefined,bytes);}},
 memory=new Memory();memory.pages=scoped(pages,run);memory.decoded=scoped(decoded,run);
 const writes=[], reader=new Reader(root,source,memory,shared,run,p=>writes.push(p),{remaining:900}), start=performance.now();
 ${!frozen ? `const suffix=new SuffixReader(manifest,(file,offset,length)=>read('suffix',file,offset,length),${variable("suffix-fences.bin")},{memory:suffixMemory.scoped(run),intervals:${variable("suffix-intervals.bin")},phraseRanks:${variable("suffix-ranks.bin")},${manifest.numericPackets ? `numericIndex:${variable("suffix-numeric-index.bin")},` : ""}${manifest.phraseRankIndex ? `phraseRankIndex:${variable("suffix-rank-index.bin")}` : ""}});` : ""}
 const result=${frozen ? "await engine.search(input.q,reader,input.options)" : "await searchWithSuffix(engine,suffix,input.q,reader,input.options,{bits:16,rangeMax:true})"};
 const response=JSON.stringify({result,requestId:run,isolateId,wallMs:performance.now()-start,${!frozen ? "suffixBuffers:suffix.buffers," : ""}retainedPageBytes:memory.pages.bytes,retainedDecodedBytes:memory.decoded.bytes});
 await Promise.all(writes);return new Response(response,{headers:{'content-type':'application/json'}});
 }};`;
  await mkdir(moduleRoot, { recursive: true });
  const compiled = await build({
      stdin: {
        contents: entry,
        resolveDir: moduleRoot,
        sourcefile: "entry.ts",
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["browser", "module", "main"],
      target: "es2022",
      write: false,
      external: ["node:*", "cloudflare:*"],
      plugins: [
        {
          name: "data",
          setup(b) {
            b.onResolve({ filter: /\.bin$/ }, (a) => ({
              path: a.path,
              external: true,
            }));
          },
        },
      ],
    }),
    js = compiled.outputFiles[0].text;
  await writeFile(out + "/" + mode + ".js", js);
  const bundleBytes =
      Buffer.byteLength(js) +
      Object.values(moduleData).reduce((n, b) => n + b.length, 0),
    start = performance.now(),
    mf = new Miniflare({
      name: "suffix-native-" + mode,
      compatibilityDate: "2026-11-01",
      compatibilityFlags: ["nodejs_compat"],
      inspectorPort: 0,
      modulesRoot: moduleRoot,
      modules: [
        { type: "ESModule", path: moduleRoot + "/entry.js", contents: js },
        ...Object.entries(moduleData).map(([name, contents]) => ({
          type: "Data" as const,
          path: moduleRoot + "/" + name,
          contents,
        })),
      ],
      serviceBindings: {
        DATA: async (request: Request) => {
          try {
            const h = request.headers,
              job = jobs.get(h.get("run")!),
              op = h.get("op"),
              key = h.get("key")!,
              offset = Number(h.get("offset")),
              length = Number(h.get("length"));
            if (!job) throw Error("Missing request state");
            if (op === "sharedGet") {
              const raw = await job.engine.shared.get(key);
              return new Response(raw ?? null, {
                headers: { hit: raw ? "1" : "0" },
              });
            }
            if (op === "sharedPut") {
              await job.engine.shared.put(
                key,
                new Uint8Array(await request.arrayBuffer()),
              );
              return new Response("");
            }
            let raw: Uint8Array, sha256: string | undefined;
            if (op === "suffix")
              raw = await job.slots.run(() =>
                job.suffix.source.read(key, offset, length),
              );
            else if (op === "read")
              raw = await job.slots.run(() =>
                job.engine.source.read(key, offset, length),
              );
            else if (op === "named")
              raw = await job.slots.run(() =>
                job.engine.source.readNamed(key, length),
              );
            else if (op === "whole") {
              const r = await job.slots.run(() =>
                job.engine.source.readWhole(
                  key,
                  JSON.parse(h.get("range")!) ?? undefined,
                ),
              );
              raw = r.data;
              sha256 = r.sha256;
            } else throw Error("Unknown source operation");
            return new Response(raw! as BodyInit, {
              headers: sha256 ? { sha256 } : {},
            });
          } catch (e) {
            console.error(e);
            return new Response(String(e), { status: 500 });
          }
        },
      },
    });
  await mf.ready;
  const startupMs = performance.now() - start,
    inspector = await connect(mf),
    heap = await inspector.send("Runtime.getHeapUsage");
  console.log(mode, { bundleBytes, startupMs, heap });
  return {
    mf,
    inspector,
    bundleBytes,
    startupMs,
    heap,
    scriptSha256: createHash("sha256").update(js).digest("hex"),
    samples: [heap],
    activeSamples: [],
  };
}
const workers: any = {},
  rows: any[] = [];
try {
  for (const mode of modes) workers[mode] = await worker(mode);
  let seed = 879133;
  const random = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32,
    repeats = Number(process.env.CWS_REPEATS ?? 3),
    tasks = selected
      .flatMap((sid) =>
        Array.from({ length: repeats }, (_, repeat) =>
          modes.map((mode) => ({
            sid,
            repeat,
            mode,
            order: random(),
          })),
        ).flat(),
      )
      .sort((a, b) => a.order - b.order);
  const runTask = async (task: (typeof tasks)[number]) => {
    const s = contract.scenarios[task.sid],
      runId = randomUUID(),
      job = {
        engine: new SimulatedIO(storage, model),
        suffix: new SimulatedIO({ read: suffixRead }, model),
        slots: new Semaphore(6),
      };
    jobs.set(runId, job);
    const start = performance.now(),
      r = await workers[task.mode].mf.dispatchFetch("http://native/search", {
        method: "POST",
        body: JSON.stringify({
          runId,
          q: s.q,
          options: {
            ...s.options,
            exactTotal: false,
            metadata: true,
            snippets: true,
          },
        }),
      }),
      raw = await r.text(),
      wallMs = performance.now() - start;
    jobs.delete(runId);
    if (!r.ok) throw Error(raw);
    const body = JSON.parse(raw);
    const expected = contract.rows.find((x: any) => x.sid === task.sid).result
      .results;
    if (
      JSON.stringify(body.result.results.map((h: any) => h.doc)) !==
      JSON.stringify(expected.map((h: any) => h.doc))
    )
      throw Error("Rank mismatch " + s.q);
    for (let i = 0; i < expected.length; i++)
      if (
        Math.abs(body.result.results[i].score - expected[i].score) >
        1e-10 * Math.max(1, expected[i].score)
      )
        throw Error("Score mismatch");
    const heap = await workers[task.mode].inspector.send(
      "Runtime.getHeapUsage",
    );
    workers[task.mode].samples.push(heap);
    rows.push({
      ...task,
      q: s.q,
      ...body,
      clientMs: wallMs,
      workerWallMs: body.wallMs,
      heap,
      io: { engine: job.engine.calls, suffix: job.suffix.calls },
      correct: true,
    });
    console.log(
      rows.length,
      "/",
      tasks.length,
      task.mode,
      task.sid,
      Math.round(wallMs) + "ms",
    );
  };
  for (let at = 0; at < tasks.length; at += concurrency) {
    let sampling = memoryProfile;
    const chunk = tasks.slice(at, at + concurrency),
      activeModes = [...new Set(chunk.map((t) => t.mode))];
    if (memoryProfile)
      await Promise.all(
        activeModes.map(async (mode) => {
          const collected: any = await (
            await workers[mode].mf.dispatchFetch("http://native/__gc")
          ).json();
          if (!collected.available)
            throw Error(
              "Memory profiling requires MINIFLARE_WORKERD_V8_FLAGS=--expose-gc",
            );
        }),
      );
    const profiles = memoryProfile
      ? activeModes.map(async (mode) => {
          while (sampling) {
            const heap = await workers[mode].inspector.send(
              "Runtime.getHeapUsage",
            );
            workers[mode].activeSamples.push({
              at: performance.now(),
              requests: chunk.filter((t) => t.mode === mode).length,
              ...heap,
            });
            await new Promise((r) => setTimeout(r, 20));
          }
        })
      : [];
    try {
      await Promise.all(chunk.map(runTask));
    } finally {
      sampling = false;
      await Promise.all(profiles);
    }
    await writeFile(
      out + "/results.json.gz",
      gzipSync(
        JSON.stringify({
          kind: "Local workerd, simulated R2; not live Cloudflare",
          manifest: manifest.generation,
          control: controlCommit,
          code: execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          model,
          applicationCaches: "All application caches are new for every request",
          cacheBudgets:
            "Isolate-wide LRUs; request namespaces prevent cross-request hits",
          concurrency,
          memoryProfile,
          v8Flags: process.env.MINIFLARE_WORKERD_V8_FLAGS ?? null,
          rows,
        }),
      ),
    );
  }
  const memory: any = {};
  for (const [mode, w] of Object.entries<any>(workers)) {
    const before = await w.inspector.send("Runtime.getHeapUsage");
    const collected: any = await (
      await w.mf.dispatchFetch("http://native/__gc")
    ).json();
    const retained = collected.available
      ? await w.inspector.send("Runtime.getHeapUsage")
      : {
          unavailable:
            "Run with MINIFLARE_WORKERD_V8_FLAGS=--expose-gc to measure after garbage collection",
        };
    memory[mode] = {
      bundleBytes: w.bundleBytes,
      startupMs: w.startupMs,
      scriptSha256: w.scriptSha256,
      startupHeap: w.heap,
      postRequestSamples: w.samples,
      activeSamples: w.activeSamples,
      beforeGC: before,
      retained,
    };
  }
  await writeFile(
    out + "/results.json.gz",
    gzipSync(
      JSON.stringify({
        kind: "Local workerd, simulated R2; not live Cloudflare",
        manifest: manifest.generation,
        control: controlCommit,
        code: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        model,
        corpus: {
          generation: assets.root.generation,
          count: assets.root.count,
          hash: assets.root.corpusHash,
        },
        applicationCaches: "All application caches are new for every request",
        cacheBudgets:
          "Isolate-wide LRUs; request namespaces prevent cross-request hits",
        v8Flags: process.env.MINIFLARE_WORKERD_V8_FLAGS ?? null,
        concurrency,
        memoryProfile,
        rows,
        memory,
        completedAt: new Date().toISOString(),
      }),
    ),
  );
  console.log(JSON.stringify(memory, null, 2));
} finally {
  for (const w of Object.values<any>(workers)) {
    w.inspector.close();
    await w.mf.dispose();
  }
  await Promise.all([...handles.values()].map(async (p) => (await p).close()));
}
