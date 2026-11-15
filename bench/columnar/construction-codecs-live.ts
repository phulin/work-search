import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { benchmarkToken } from "./token.js";
import {
  decodeRunBlock,
  type RunCodec,
} from "../../src/columnar/construction/block-codec.js";
import type { Run, Chunk } from "../../src/columnar/construction/runs.js";
const [url, out] = process.argv.slice(2);
if (
  !/^https:\/\/work-search-cws-fresh-[a-z0-9-]+\.phulin\.workers\.dev$/.test(
    url ?? "",
  ) ||
  !out
)
  throw Error("Usage: construction-codecs-live.ts ISOLATED_URL OUTPUT");
await mkdir(out, { recursive: true });
const token = await benchmarkToken(),
  build = "codec-" + Date.now(),
  rows: any[] = [];
const health = await fetch(url + "/health", {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json());
async function call(path: string, task: string, input: any) {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now(),
      r = await fetch(url + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ build, task, ...input }),
      }),
      body = (await r.json()) as any;
    rows.push({
      path,
      task,
      attempt,
      status: r.status,
      clientMs: performance.now() - started,
      ray: r.headers.get("cf-ray")?.split("-")[0],
      telemetry: body.telemetry,
    });
    if (r.ok) return body.output;
    if (r.status !== 503 || attempt >= 20) throw Error(body.error);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const runs: Run[] = [];
for (let first = 1000000; first < 1002048;) {
  const run = await call("/ingest", "input-" + first, {
    first,
    count: Math.min(128, 1002048 - first),
    codec: "delta-gzip-v3",
    blockBytes: 262144,
    containerBytes: 16 * 1048576,
  });
  runs.push(run);
  first = run.next;
}
if (runs.length > 16)
  throw Error("Codec fixture requires at most 16 input runs");
const configs: {
  codec: RunCodec;
  blockBytes: number;
  containerBytes: number;
}[] = [];
for (const codec of ["raw", "gzip", "delta-gzip-v3"] as const)
  for (const blockBytes of [65536, 262144, 1048576])
    for (const containerBytes of [1048576, 16 * 1048576])
      configs.push({ codec, blockBytes, containerBytes });
let seed = 117613;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
for (let i = configs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [configs[i], configs[j]] = [configs[j], configs[i]];
}
const results: any[] = [];
let expected: string | undefined;
for (const [i, config] of configs.entries()) {
  let state: any,
    done = false,
    step = 0;
  const chunks: Chunk[] = [],
    sampleStart = rows.length;
  const start = performance.now();
  do {
    const r = await call("/merge", `merge-${i}-${step++}`, {
      ...config,
      runs,
      state,
      byteBudget: 128 * 1048576,
    });
    state = r.state;
    done = state.done;
    chunks.push(...r.chunks);
  } while (!done);
  const clientMs = performance.now() - start,
    samples = rows.slice(sampleStart),
    fingerprint = createHash("sha256");
  let verificationReadBytes = 0;
  for (const ref of chunks) {
    const r = await fetch(url + "/download", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref }),
      }),
      data = new Uint8Array(await r.arrayBuffer());
    if (!r.ok || createHash("sha256").update(data).digest("hex") !== ref.sha256)
      throw Error("Codec verification fetch failed");
    verificationReadBytes += data.length;
    fingerprint.update(
      await decodeRunBlock(data, ref.codec ?? "raw", ref.rawBytes),
    );
  }
  const sha256 = fingerprint.digest("hex");
  expected ??= sha256;
  if (sha256 !== expected) throw Error("Codec changed exact merged rows");
  const operations: Record<string, number> = {};
  let readBytes = 0,
    writtenBytes = 0,
    encodeMs = 0,
    decodeMs = 0,
    workerWallMs = 0;
  for (const r of samples) {
    for (const [k, n] of Object.entries(r.telemetry?.io.operations ?? {}))
      operations[k] = (operations[k] ?? 0) + (n as number);
    readBytes += r.telemetry?.io.bytesRead ?? 0;
    writtenBytes += r.telemetry?.io.bytesWritten ?? 0;
    encodeMs += r.telemetry?.codec.encodeMs ?? 0;
    decodeMs += r.telemetry?.codec.decodeMs ?? 0;
    workerWallMs += r.telemetry?.wallMs ?? 0;
  }
  const result = {
    ...config,
    clientMs,
    workerWallMs,
    encodeMs,
    decodeMs,
    operations,
    readBytes,
    writtenBytes,
    chunks: chunks.length,
    physicalObjects: new Set(chunks.map((c) => c.key)).size,
    sha256,
    verificationReadBytes,
    rays: samples.map((r) => r.ray),
  };
  results.push(result);
  console.log(result);
  await writeFile(
    out + "/results.json",
    JSON.stringify(
      {
        build,
        health,
        sourceRange: [1000000, 1002048],
        concurrency: 1,
        randomSeed: 117613,
        results,
        rows,
      },
      null,
      2,
    ),
  );
}
