import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import "../../scripts/workerd-runtime.js";
import { FileStorage } from "../../src/storage/filesystem.js";
const variant = process.argv[2] ?? "v1",
  dir =
    process.env.CWS_DIR ??
    (variant === "v1" ? "work/columnar-100k" : "work/columnar-100k-lanes"),
  out = resolve("work/columnar-profile/" + variant);
await mkdir(out, { recursive: true });
const runtime =
  variant === "v1"
    ? "work/columnar-deploy/work-search-cws-v1-source/src/columnar/worker.ts"
    : "src/columnar/worker.ts";
const pairPath =
  variant === "v1"
    ? undefined
    : await readFile(dir + "/pairs-root.json", "utf8").then(
        () => dir + "/pairs-root.json",
        () => undefined,
      );
const heads = process.env.CWS_HEADS === "1";
await writeFile(
  out + "/entry.ts",
  `import root from ${JSON.stringify(resolve(dir + "/root.json"))};import {createColumnarWorker}from ${JSON.stringify(resolve(runtime))};${pairPath ? `import pairs from ${JSON.stringify(resolve(pairPath))};` : ""}${heads ? `import hr from ${JSON.stringify(resolve(dir + "/heads-root.json"))};import hd from ${JSON.stringify(resolve(dir + "/heads.bin"))};` : ""}const worker=createColumnarWorker(root,${pairPath ? "pairs" : "undefined"}${heads ? ",{root:hr,data:new Uint8Array(hd)}" : ""});export default{fetch(request,env,ctx){return worker.fetch(request,{...env,INDEX:{async get(key,options){const r=await env.FILES.fetch('http://files/'+key,{headers:{offset:String(options.range.offset),length:String(options.range.length)}});if(!r.ok)throw Error('File '+r.status);return{customMetadata:{generation:key.split('/')[0]},arrayBuffer:()=>r.arrayBuffer()};}}},ctx);}};`,
);
await writeFile(
  out + "/wrangler.json",
  JSON.stringify({
    name: "cws-profile-" + variant,
    main: out + "/entry.ts",
    compatibility_date: "2026-11-01",
  }),
);
const dry = spawnSync(
  "yarn",
  [
    "wrangler",
    "deploy",
    "--config",
    out + "/wrangler.json",
    "--dry-run",
    "--outdir",
    out + "/dist",
  ],
  { encoding: "utf8" },
);
if (dry.status) throw Error(dry.stdout + dry.stderr);
const disk = new FileStorage(dir + "/packs"),
  pairDisk = new FileStorage(dir + "/pairs/packs"),
  base = JSON.parse(await readFile(dir + "/root.json", "utf8"));
const mf = new Miniflare({
  compatibilityDate: "2026-11-01",
  compatibilityFlags: ["nodejs_compat"],
  name: "cws-profile-" + variant,
  modules: true,
  modulesRules: [{ type: "Data", include: ["**/*.bin"], fallthrough: true }],
  scriptPath: out + "/dist/entry.js",
  inspectorPort: 0,
  bindings: { INTERNAL_TOKEN: "profile", PAGE_CACHE: "1" },
  serviceBindings: {
    FILES: async (request: Request) => {
      const key = new URL(request.url).pathname.slice(1),
        offset = Number(request.headers.get("offset")),
        length = Number(request.headers.get("length"));
      return new Response(
        await (key.startsWith(base.generation + "/") ? disk : pairDisk).read(
          key.split("/").at(-1)!,
          offset,
          length,
        ),
      );
    },
  },
});
const queries = [
  "summary judgment",
  '"clear and convincing evidence"',
  "motion /5 ten",
  "subject /5 matter jurisdiction",
  "(any OR oral) AND because",
  "court",
  '"on that advice appellant"',
];
let socket: WebSocket | undefined;
const rows: any[] = [],
  memory: any[] = [];
try {
  await mf.ready;
  const url = await mf.getInspectorURL(),
    http = new URL(url);
  http.protocol = "http:";
  const targets = (await fetch(new URL("/json/list", http)).then((r) =>
      r.json(),
    )) as any[],
    target =
      targets.find((t) => t.title.includes("cws-profile-" + variant)) ??
      targets[0];
  if (!target) throw Error("No inspector");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((ok, no) => {
    socket!.addEventListener("open", () => ok(), { once: true });
    socket!.addEventListener(
      "error",
      () => no(Error("Inspector connection failed")),
      { once: true },
    );
  });
  let sequence = 0;
  const waiting = new Map<
    number,
    {
      ok: (v: any) => void;
      no: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  socket.addEventListener("message", (event) => {
    const v = JSON.parse(String(event.data));
    if (!v.id) return;
    const p = waiting.get(v.id);
    if (!p) return;
    waiting.delete(v.id);
    clearTimeout(p.timer);
    v.error ? p.no(Error(JSON.stringify(v.error))) : p.ok(v.result);
  });
  const cdp = (method: string, params?: unknown) =>
    new Promise<any>((ok, no) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => {
          waiting.delete(id);
          no(Error("Inspector timeout: " + method));
        },
        method === "HeapProfiler.collectGarbage" ? 3000 : 10000,
      );
      waiting.set(id, { ok, no, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  const call = async (q: string, resetMemory = true) => {
    const start = performance.now(),
      r = await mf.dispatchFetch("http://profile/search", {
        method: "POST",
        headers: {
          authorization: "Bearer profile",
          "content-type": "application/json",
        },
        body: JSON.stringify({ q, resetMemory }),
      });
    const b = (await r.json()) as any;
    if (!r.ok) throw Error(q + ": " + JSON.stringify(b));
    return { q, ms: performance.now() - start, diagnostics: b.diagnostics };
  };
  const heap = async (label: string) => {
    try {
      memory.push({ label, ...(await cdp("Runtime.getHeapUsage")) });
    } catch (e) {
      memory.push({ label, error: String(e) });
    }
  };
  await cdp("Profiler.enable");
  await cdp("Profiler.setSamplingInterval", { interval: 1000 });
  await heap("startup");
  for (const [qi, q] of queries.entries()) {
    await call(q);
    await call(q);
    await heap("before-" + qi);
    await cdp("Profiler.start");
    for (let i = 0; i < 4; i++)
      rows.push({ ...(await call(q)), phase: "cpu", qi, i });
    const cpu = await cdp("Profiler.stop");
    await writeFile(
      out + `/${qi}.cpuprofile.gz`,
      gzipSync(JSON.stringify(cpu.profile)),
    );
    await cdp("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < 2; i++)
      rows.push({ ...(await call(q)), phase: "allocation", qi, i });
    const allocation = await cdp("HeapProfiler.stopSampling");
    await writeFile(
      out + `/${qi}.heapprofile.gz`,
      gzipSync(JSON.stringify(allocation.profile)),
    );
    await heap("after-" + qi);
    console.log("profiled", q);
  }
  let polling = true;
  const sample = (async () => {
    while (polling) {
      await heap("concurrent");
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      call(queries[i % queries.length], false),
    ),
  );
  polling = false;
  await sample;
  rows.push({
    phase: "concurrency",
    outcomes: outcomes.map((r) =>
      r.status === "fulfilled"
        ? { status: "ok", ...r.value }
        : { status: "rejected", error: String(r.reason) },
    ),
  });
  await heap("after-concurrency");
  try {
    await cdp("HeapProfiler.collectGarbage");
    await heap("retained-after-gc");
  } catch (e) {
    memory.push({ label: "forced-gc-unavailable", error: String(e) });
  }
} finally {
  await writeFile(
    out + "/requests.json",
    JSON.stringify(
      {
        kind: "Local workerd attribution and inspector heap observations; no claim of native Worker peak memory",
        variant,
        dir,
        queries,
        rows,
        memory,
      },
      null,
      2,
    ),
  );
  socket?.close();
  await mf.dispose();
}
