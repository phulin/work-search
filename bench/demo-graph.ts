import { readFile, writeFile, open } from "node:fs/promises";
import { createShard } from "../demo/shard-runtime.js";
import gateway from "../demo/gateway-runtime.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { openIndex, type PagedIndex } from "../src/format/paged.js";
import {
  context,
  tracedBucket,
  tracedService,
  type Trace,
} from "./demo-trace.js";
import { EmpiricalModel, Slots, sleep } from "./demo-model.js";
import { root, snapshot, range } from "./demo-client.js";

export interface LocalTrace extends Trace {
  slots: Slots;
  model: EmpiricalModel;
  diagnostics: any[];
}

export async function createDemoGraph(hydrate = false) {
  const level = Number(process.env.DEMO_OPT_STAGE ?? 0);
  const artifacts = await readFile(root + "/cards.json", "utf8").then(
    JSON.parse,
    () => ({}),
  );
  if (level >= 3)
    Object.assign(
      artifacts,
      JSON.parse(await readFile(root + "/routes.json", "utf8")),
    );
  const artifactBytes = async (key: string, options?: any) => {
    const a = artifacts[key];
    if (!options?.range) return readFile(a.path);
    const f = await open(a.path, "r"),
      bytes = new Uint8Array(options.range.length);
    try {
      const r = await f.read(bytes, 0, bytes.length, options.range.offset);
      if (r.bytesRead !== bytes.length)
        throw Error("Truncated benchmark artifact");
      return bytes;
    } finally {
      await f.close();
    }
  };
  const calibration = JSON.parse(
    await readFile(root + "/latency.json", "utf8"),
  );
  const manifest = await readFile(root + "/case-manifest.json");
  const traces = () => context.getStore() as LocalTrace | undefined;
  const runtimes: SearchRuntime[] = [],
    profiles: any[] = [];
  const bucket = {
    get: async (key: string, options?: any) => {
      if (key.endsWith("/cardroot-0.bin") && !artifacts[key]) return null;
      const t = traces(),
        bytes = artifacts[key]
          ? await artifactBytes(key, options)
          : key === "demo-case-metadata.json"
            ? manifest
            : await range(
                key,
                options?.range?.offset ?? 0,
                options?.range?.length,
                hydrate,
              );
      const { headersMs, bodyMs } = t?.model.sample(bytes.length) ?? {
        headersMs: 0,
        bodyMs: 0,
      };
      const release = await t?.slots.acquire();
      try {
        await sleep(headersMs);
      } finally {
        release?.();
      }
      const consume = async () => {
        await sleep(bodyMs);
        return bytes;
      };
      let stream: ReadableStream<Uint8Array> | undefined,
        position = 0;
      return {
        customMetadata: { generation: key.split("/")[0] },
        size: bytes.length,
        arrayBuffer: async () => {
          const b = await consume();
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
        json: async () => JSON.parse(new TextDecoder().decode(await consume())),
        get body() {
          return (stream ??= new ReadableStream({
            async pull(controller) {
              const begin = position;
              position = Math.min(bytes.length, position + 65536);
              await sleep(
                (bodyMs * (position - begin)) / Math.max(1, bytes.length),
              );
              controller.enqueue(bytes.subarray(begin, position));
              if (position === bytes.length) controller.close();
            },
          }));
        },
      };
    },
  } as unknown as R2Bucket;
  const leafEnvs = new Map<number, any>(),
    token = "local-benchmark-only",
    groups = new Map<number, any[]>();
  const setupStart = performance.now();
  for (const s of snapshot.shards) {
    const bytes = await readFile(root + "/bundles/" + s.id + ".bin"),
      index = openIndex(bytes) as PagedIndex;
    if (index.generation !== s.generation || index.count !== s.documents)
      throw Error("Snapshot bundle mismatch");
    const lengths: number[] = [],
      titles: number[] = [];
    for (
      let d = 0;
      d < index.count;
      d += Math.max(1, Math.floor(index.count / 2000))
    ) {
      const l = index.lengths(d);
      lengths.push(l.body);
      titles.push(l.title);
    }
    profiles.push({
      id: s.id,
      count: index.count,
      avgBody: index.avgBody,
      avgTitle: index.avgTitle,
      terms: index.termCount,
      rootBytes: bytes.length,
      localNorms: !!index.localNorms,
      localIds: !!index.localIds,
      bodySample: lengths,
      titleSample: titles,
    });
    const runtime = new SearchRuntime(4 * 1048576);
    runtimes.push(runtime);
    const handler = createShard(bytes, runtime, (d) =>
      traces()?.diagnostics.push({ shard: s.id, ...(d as any) }),
    );
    const env = {
      INDEX: tracedBucket(bucket),
      INTERNAL_TOKEN: token,
      SHARD_ID: String(s.id),
    };
    const service = {
      fetch: (url: string, init: RequestInit) =>
        handler.fetch(new Request(url, init), env),
    };
    const group = Math.floor(s.id / 32);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ s, service });
  }
  const env: any = {
      INDEX: tracedBucket(bucket),
      INTERNAL_TOKEN: token,
      ROLE: "root",
      PERF_LEVEL: String(level),
      GLOBAL_ROUTES:
        level >= 3 ? await readFile(root + "/routes/root.bin") : undefined,
      CHILDREN: "[]",
    },
    children: any[] = [];
  for (const [g, leaves] of groups) {
    const groupEnv: any = {
      INTERNAL_TOKEN: token,
      ROLE: "router",
      CHILDREN: JSON.stringify(
        leaves.map(({ s }, i) => ({
          binding: `CHILD_${i}`,
          min: s.id,
          max: s.id,
        })),
      ),
    };
    for (const [i, { service, s }] of leaves.entries())
      groupEnv[`CHILD_${i}`] = tracedService(service as any, "shard-" + s.id);
    const service = {
      fetch: (url: string, init: RequestInit) =>
        gateway.fetch(new Request(url, init), groupEnv),
    };
    const binding = `GROUP_${g}`;
    env[binding] = tracedService(service as any, "group-" + g);
    children.push({ binding, min: g * 32, max: g * 32 + 31 });
  }
  env.CHILDREN = JSON.stringify(children);
  await writeFile(
    root + "/corpus.json",
    JSON.stringify(
      {
        snapshot: snapshot.capturedAt,
        shards: profiles,
        setupMs: performance.now() - setupStart,
      },
      null,
      2,
    ),
  );

  return { env, runtimes, calibration, profiles, bucket };
}
