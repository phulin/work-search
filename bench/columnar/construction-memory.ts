import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { deepStrictEqual } from "node:assert/strict";
import { unpack } from "../../src/columnar/format.js";
import { Miniflare } from "miniflare";
import "../../scripts/workerd-runtime.js";
import { benchmarkToken } from "./token.js";

const [indexDirectory, deploymentDirectory, out] = process.argv.slice(2);
if (!out)
  throw Error(
    "Use COMPLETED_BUILD_DIRECTORY DEPLOYMENT_DIRECTORY OUTPUT_DIRECTORY",
  );
await mkdir(out, { recursive: true });
const sourceRoot = JSON.parse(
  await readFile(deploymentDirectory + "/source-root.json", "utf8"),
);
const activation = JSON.parse(
  await readFile(indexDirectory + "/tasks/activate-catalogue.json", "utf8"),
);
const nativePackages = JSON.parse(
  await readFile(indexDirectory + "/packages.json", "utf8"),
);
const catalogueRef = activation.body.catalogueRef;
const token = await benchmarkToken(),
  seeded = new Set<string>();
let seedRequests = 0,
  seedBytes = 0;
const mf = new Miniflare({
  name: "cws-construction-memory",
  modules: true,
  scriptPath: resolve(deploymentDirectory + "/dist/entry.js"),
  compatibilityDate: "2026-11-01",
  inspectorPort: 0,
  r2Buckets: ["INDEX"],
  bindings: { INTERNAL_TOKEN: "memory" },
});
let socket: WebSocket | undefined;
const memory: any[] = [],
  rows: any[] = [],
  profiles: any[] = [];
try {
  await mf.ready;
  const bucket = await mf.getR2Bucket("INDEX");
  async function seed(key: string, length?: number) {
    if (seeded.has(key)) return;
    const archiveObject = /\/(?:content|info)-\d+\.bin$/.test(key);
    const oracle = process.env.CWS_ORACLE_URL;
    if (
      archiveObject &&
      !/^https:\/\/work-search-cws-oracle-[a-z0-9-]+\.phulin\.workers\.dev$/.test(
        oracle ?? "",
      )
    )
      throw Error(
        "Set CWS_ORACLE_URL to an isolated oracle for source byte reads",
      );
    const response = await fetch(
      archiveObject
        ? oracle + "/source-object"
        : "https://work-search-cws-upload.phulin.workers.dev/" + key,
      {
        ...(archiveObject
          ? { method: "POST", body: JSON.stringify({ key, length }) }
          : {}),
        headers: {
          authorization: `Bearer ${token}`,
          ...(length === undefined
            ? {}
            : { "x-offset": "0", "x-length": String(length) }),
        },
      },
    );
    if (
      !response.ok ||
      response.headers.get("x-generation") !== key.split("/")[0]
    )
      throw Error("Source seed identity " + response.status);
    const raw = new Uint8Array(await response.arrayBuffer());
    seedRequests++;
    seedBytes += raw.length;
    if (length !== undefined && raw.length !== length)
      throw Error("Truncated seed range");
    await bucket.put(key, raw, {
      customMetadata: {
        generation: key.split("/")[0],
        sha256:
          response.headers.get("x-sha256") ??
          createHash("sha256").update(raw).digest("hex"),
      },
    });
    seeded.add(key);
  }
  await seed(catalogueRef.key);
  const catalogue = JSON.parse(
    await (await bucket.get(catalogueRef.key))!.text(),
  );
  for (const ref of [
    ...catalogue.words.map((w: any) => w.ref),
    ...Object.values(catalogue.commonBundle ?? {}),
  ] as any[])
    await seed(ref.key);
  const part = sourceRoot.parts[0];
  if (!part.pointerMap || part.first !== 0 || part.count < 1024)
    throw Error(
      "Memory fixture requires first 1024 archived documents in a filtered source part",
    );
  await seed(part.pointerMap.key);
  const pointers = new DataView(
    await (await bucket.get(part.pointerMap.key))!.arrayBuffer(),
  );
  const ends = new Map<string, number>();
  for (let row = 0; row < 1024; row++)
    for (const [field, prefix] of [
      [0, "content"],
      [16, "info"],
    ] as const) {
      const at = row * 32 + field,
        name = `${part.generation}/${prefix}-${pointers.getUint32(at, true)}.bin`;
      ends.set(
        name,
        Math.max(
          ends.get(name) ?? 0,
          pointers.getUint32(at + 4, true) + pointers.getUint32(at + 8, true),
        ),
      );
    }
  for (const [key, end] of ends) await seed(key, end);
  console.log("Seeded local R2", {
    objects: seeded.size,
    seedRequests,
    seedBytes,
  });
  const inspector = new URL(await mf.getInspectorURL());
  inspector.protocol = "http:";
  const targets = (await fetch(new URL("/json/list", inspector)).then((r) =>
    r.json(),
  )) as any[];
  const target =
    targets.find((t) => t.title.includes("cws-construction-memory")) ??
    targets[0];
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
      ok: (x: any) => void;
      no: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)),
      task = waiting.get(message.id);
    if (!task) return;
    waiting.delete(message.id);
    clearTimeout(task.timer);
    message.error
      ? task.no(Error(JSON.stringify(message.error)))
      : task.ok(message.result);
  });
  const post = (method: string, params?: unknown) =>
    new Promise<any>((ok, no) => {
      const id = ++sequence,
        timer = setTimeout(
          () => {
            waiting.delete(id);
            no(Error("Inspector timeout " + method));
          },
          method === "HeapProfiler.collectGarbage" ? 2500 : 30000,
        );
      waiting.set(id, { ok, no, timer });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  async function heap(label: string) {
    memory.push({
      label,
      at: Date.now(),
      ...(await post("Runtime.getHeapUsage")),
    });
  }
  const build = "local-memory-" + Date.now();
  async function call(path: string, task: string, body: any) {
    const started = performance.now();
    const response = await mf.dispatchFetch("http://memory" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer memory",
        "content-type": "application/json",
      },
      body: JSON.stringify({ build, task, ...body }),
    });
    const data = (await response.json()) as any;
    rows.push({
      path,
      task,
      status: response.status,
      ms: performance.now() - started,
      telemetry: data.telemetry,
      output: data.output
        ? {
            first: data.output.first,
            end: data.output.end,
            next: data.output.next,
            group: data.output.group,
            analysisWork: data.output.analysisWork,
          }
        : undefined,
    });
    return { status: response.status, ...data };
  }
  await post("HeapProfiler.enable");
  await post("Profiler.enable");
  await heap("startup");
  const phases =
    process.env.CWS_PROFILE_INGEST_ONLY === "1"
      ? (["ingest"] as const)
      : (["ingest", "packages", "concurrent-packages"] as const);
  for (const phase of phases) {
    await post("Profiler.start");
    await post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    let polling = true;
    const poll = (async () => {
      while (polling) {
        await heap(phase);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    const body =
      phase === "ingest"
        ? { first: 0, count: 512 }
        : {
            catalogueRef,
            generation: nativePackages[0].generation,
            first: 0,
            count: 1024,
          };
    const results = await Promise.all(
      Array.from({ length: phase === "concurrent-packages" ? 4 : 1 }, (_, i) =>
        call(
          phase === "ingest" ? "/ingest" : "/packages",
          phase + "-" + i,
          body,
        ),
      ),
    );
    polling = false;
    await poll;
    const { profile: allocation } = await post("HeapProfiler.stopSampling"),
      { profile: cpu } = await post("Profiler.stop");
    await writeFile(
      out + "/" + phase + ".heapprofile.gz",
      gzipSync(JSON.stringify(allocation)),
    );
    await writeFile(
      out + "/" + phase + ".cpuprofile.gz",
      gzipSync(JSON.stringify(cpu)),
    );
    profiles.push({
      phase,
      estimatedAllocatedBytes: allocation.samples?.reduce(
        (n: number, s: any) => n + s.size,
        0,
      ),
      samples: allocation.samples?.length,
    });
    if (phase !== "ingest") {
      const success = results.filter((r) => r.status === 200);
      if (
        !success.length ||
        results.some((r) => r.status !== 200 && r.status !== 503)
      )
        throw Error("Package output/admission mismatch");
      const actual = success[0].output.group,
        expected = nativePackages[0].group;
      deepStrictEqual(
        [actual.first, actual.end],
        [expected.first, expected.end],
      );
      if (actual.sha256 !== expected.sha256) {
        await seed(expected.sha256 + "/plan-0.bin");
        const a = new Uint8Array(
            await (await bucket.get(
              actual.sha256 + "/plan-0.bin",
            ))!.arrayBuffer(),
          ),
          b = new Uint8Array(
            await (await bucket.get(
              expected.sha256 + "/plan-0.bin",
            ))!.arrayBuffer(),
          );
        const ao = unpack(Buffer.from(actual.offsets, "base64")),
          bo = unpack(Buffer.from(expected.offsets, "base64"));
        for (let i = 0; i + 1 < ao.length; i++) {
          const x = a.subarray(ao[i], ao[i + 1]),
            y = b.subarray(bo[i], bo[i + 1]),
            xv = new DataView(x.buffer, x.byteOffset, x.byteLength),
            yv = new DataView(y.buffer, y.byteOffset, y.byteLength);
          for (const at of [0, 4, 8, 12, 16, 20, 24, 28])
            deepStrictEqual(xv.getUint32(at, true), yv.getUint32(at, true));
          deepStrictEqual(
            x.subarray(64, xv.getUint32(32, true)),
            y.subarray(64, yv.getUint32(32, true)),
          );
          deepStrictEqual(
            gunzipSync(
              x.subarray(
                xv.getUint32(32, true),
                xv.getUint32(32, true) + xv.getUint32(36, true),
              ),
            ),
            gunzipSync(
              y.subarray(
                yv.getUint32(32, true),
                yv.getUint32(32, true) + yv.getUint32(36, true),
              ),
            ),
          );
          const xd = xv.getUint32(40, true),
            yd = yv.getUint32(40, true),
            count = xv.getUint32(xd + 4, true);
          deepStrictEqual(count, yv.getUint32(yd + 4, true));
          for (let chunk = 0; chunk < count; chunk++) {
            const xp = xd + 8 + chunk * 16,
              yp = yd + 8 + chunk * 16;
            for (const at of [0, 12])
              deepStrictEqual(
                xv.getUint32(xp + at, true),
                yv.getUint32(yp + at, true),
              );
            const xa = xv.getUint32(48, true) + xv.getUint32(xp + 4, true),
              ya = yv.getUint32(48, true) + yv.getUint32(yp + 4, true);
            deepStrictEqual(
              gunzipSync(x.subarray(xa, xa + xv.getUint32(xp + 8, true))),
              gunzipSync(y.subarray(ya, ya + yv.getUint32(yp + 8, true))),
            );
          }
        }
        rows.push({
          phase,
          semanticPackagesChecked: ao.length - 1,
          note: "Compression differs between native and local workerd; numeric sections and every decompressed display/passage byte agree.",
        });
      }
    } else if (results[0].status !== 200)
      throw Error("Ingest profiling failed");
    await heap("after-" + phase);
    try {
      await post("HeapProfiler.collectGarbage");
      await heap("retained-" + phase);
    } catch (error) {
      memory.push({ label: "gc-unavailable", error: String(error) });
    }
    console.log("Profiled", phase);
  }
} finally {
  await writeFile(
    out + "/results.json",
    JSON.stringify(
      {
        indexDirectory,
        deploymentDirectory,
        sourceDocuments: 1024,
        seedRequests,
        seedBytes,
        profiles,
        rows,
        memory,
        notes: [
          "Local workerd inspector observations, not native Cloudflare peak memory.",
          "The peak of sampled heap/backing storage is a lower bound on the instantaneous maximum.",
          "Allocation sampling includes collected objects and is a cumulative estimate, distinct from retained heap.",
          "R2 input/output storage runs outside the measured application isolate.",
          "Archived bytes and catalogue match the native 8192-document build. Package hashes are compared; if compression differs, numeric sections and all decompressed presentation bytes must agree.",
          "Four simultaneous calls test the one-active-request admission rule in a shared isolate; native requests may use separate isolates.",
        ],
      },
      null,
      2,
    ),
  );
  socket?.close();
  await mf.dispose();
}
