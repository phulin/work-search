import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { buildGlobal } from "../src/global/build.js";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader, ReadBudget } from "../src/global/storage.js";
import { buildPairs } from "../src/global/pair-build.js";
import { decodePairRoot } from "../src/global/pairs.js";
import { FileStorage } from "../src/storage/filesystem.js";
import type { Address, Root } from "../src/global/format.js";
import { SearchRuntime } from "../src/query/runtime.js";
it("serves the global Worker in workerd with real R2, Cache API and diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-worker-"));
  let mf: Miniflare | undefined;
  try {
    await writeFile(
      dir + "/input",
      Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({
          id: "d" + i,
          title: "Court",
          body:
            (i % 3
              ? "clear and convincing evidence case "
              : "clear gap and convincing evidence case ") + i,
          metadata: { court: "Test court" },
        }),
      ).join("\n"),
    );
    const manifest = await buildGlobal({
      input: dir + "/input",
      out: dir + "/index",
      budgets: [1048576],
    });
    await buildPairs({
      input: dir + "/input",
      source: dir + "/index/source",
      base: dir + "/index",
      out: dir + "/pairs",
      minDf: 1,
      vocabulary: 32,
      budgetBytes: 1048576,
      inlineRarePairs: true,
    });
    const baseBytes = await readFile(dir + "/index/bundle-1.bin"),
      pairBytes = await readFile(dir + "/pairs/pairs.bin"),
      index = new GlobalIndex(baseBytes),
      pairManifest = decodePairRoot(pairBytes, index.root);
    await writeFile(
      dir + "/entry.ts",
      `import bytes from './index/bundle-1.bin';import pairBytes from './pairs/pairs.bin';import {createGlobalWorker} from ${JSON.stringify(resolve("src/global/worker-runtime.ts"))};export default createGlobalWorker(new Uint8Array(bytes), new Uint8Array(pairBytes));`,
    );
    const config = {
      name: "global-test",
      main: dir + "/entry.ts",
      compatibility_date: "2026-11-01",
      rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
    };
    await writeFile(dir + "/wrangler.json", JSON.stringify(config));
    const dry = spawnSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--config",
        dir + "/wrangler.json",
        "--dry-run",
        "--outdir",
        dir + "/dist",
      ],
      { encoding: "utf8" },
    );
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    const script = dir + "/dist/entry.js",
      text = await readFile(script, "utf8"),
      names = [...text.matchAll(/["']\.\/([^"']+\.bin)["']/g)].map(
        (match) => match[1],
      );
    mf = new Miniflare({
      modules: [
        { type: "ESModule", path: script },
        ...(await Promise.all(
          names.map(async (name) => ({
            type: "Data" as const,
            path: dir + "/dist/" + name,
            contents: await readFile(dir + "/dist/" + name),
          })),
        )),
      ],
      modulesRoot: dir,
      scriptPath: script,
      r2Buckets: ["INDEX"],
      bindings: {
        PAGE_CACHE: "1",
        PAIR_INTERSECT: "1",
        ADAPTIVE_PROBE: "fused",
        DIAGNOSTICS: "1",
        INTERNAL_TOKEN: "test",
        PAGE_READ_KIB: "256",
      },
    });
    const bucket = await mf.getR2Bucket("INDEX");
    for (const o of manifest.objects)
      await bucket.put(
        manifest.generation + "/" + o.name,
        await readFile(dir + "/index/packs/" + o.name),
        { customMetadata: { generation: manifest.generation } },
      );
    for (const object of pairManifest.root.objects)
      await bucket.put(
        pairManifest.root.generation + "/" + object.name,
        await readFile(
          dir +
            "/pairs/packs/" +
            pairManifest.root.generation +
            "/" +
            object.name,
        ),
        { customMetadata: { generation: pairManifest.root.generation } },
      );
    const health: any = await (
      await mf.dispatchFetch("https://search/health")
    ).json();
    expect(health.bundleBytes).toBe(baseBytes.length + pairBytes.length);
    expect(health.pairGeneration).toBe(pairManifest.root.generation);
    expect(health.generation).toBe(index.root.generation);
    const r = await mf.dispatchFetch("https://search/search", {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: JSON.stringify({ q: '"clear and convincing evidence"', limit: 20 }),
    });
    const first: any = await r.json();
    expect(r.status, JSON.stringify(first)).toBe(200);
    expect(first.results).toHaveLength(20);
    const pairRounds = first.diagnostics.rounds.filter((r: any) =>
      r.stage.startsWith("pair-"),
    );
    expect(pairRounds.map((r: any) => r.stage)).toContain("pair-dictionary");
    expect(pairRounds.map((r: any) => r.stage)).toContain("pair-candidates");
    expect(
      pairRounds.reduce((n: number, r: any) => n + r.requests, 0),
    ).toBeGreaterThan(0);
    expect(first.diagnostics.pairCandidates).toBe(33);
    expect(first.diagnostics.requests).toBe(
      first.diagnostics.rounds.reduce((n: number, r: any) => n + r.requests, 0),
    );
    expect(first.diagnostics.bytes).toBe(
      first.diagnostics.rounds.reduce((n: number, r: any) => n + r.bytes, 0),
    );
    expect(first.diagnostics.indexRounds).toBe(
      first.diagnostics.rounds.filter(
        (r: any) => r.stage !== "results-and-passages" && r.requests > 0,
      ).length,
    );
    expect(first.results[0].excerpt).toContain("clear and convincing evidence");
    expect(first.diagnostics.rounds.at(-1).stage).toBe("results-and-passages");
    const second: any = await (
      await mf.dispatchFetch("https://search/search", {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: JSON.stringify({ q: "convincing evidence", resetMemory: true }),
      })
    ).json();
    expect(second.results).toHaveLength(20);
    expect(
      second.diagnostics.rounds.reduce(
        (n: number, r: any) => n + r.sharedHits,
        0,
      ),
    ).toBeGreaterThan(0);
    const disk = new FileStorage(dir + "/index/packs");
    for (const q of [
      '"case 1"',
      '"clear and convincing evidence"',
      '"clear and" OR "gap and"',
      '"clear and" OR gap',
      'NOT "clear and"',
      '"convincing evidence" AND NOT "clear gap"',
    ]) {
      const expected = await index.search(
        new PageReader(index.root, {
          read: (key, offset, length) =>
            disk.read(key.split("/").at(-1)!, offset, length),
        }),
        q,
      );
      const response = await mf.dispatchFetch("https://search/search", {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: JSON.stringify({ q, resetMemory: true }),
      });
      expect(response.status, q).toBe(200);
      const actual: any = await response.json();
      expect(actual.results, q).toEqual(expected.results);
      if (q === '"case 1"') {
        expect(actual.diagnostics.pairCandidates).toBe(1);
        expect(
          actual.diagnostics.rounds.some(
            (r: any) => r.stage === "pair-candidates",
          ),
        ).toBe(false);
      }
    }
    expect(
      (await mf.dispatchFetch("https://search/search?q=hi&field=bad")).status,
    ).toBe(400);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
it("shares immutable pages across new readers for unfamiliar queries without caching responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "global-cache-"));
  try {
    await writeFile(
      dir + "/docs",
      JSON.stringify({ id: "a", body: "alpha beta gamma" }),
    );
    const m = await buildGlobal({
      input: dir + "/docs",
      out: dir + "/index",
      budgets: [1048576],
    });
    const index = new GlobalIndex(await readFile(dir + "/index/bundle-1.bin")),
      pages = new Map<string, Uint8Array>(),
      cache = {
        get: async (k: string) => pages.get(k),
        put: async (k: string, b: Uint8Array) => {
          pages.set(k, b);
        },
      },
      source = {
        read: async (k: string, o: number, n: number) => {
          const b = await readFile(dir + "/index/packs/" + k.split("/").at(-1));
          return b.subarray(o, o + n);
        },
      };
    await index.search(
      new PageReader(index.root, source, new SearchRuntime(0), cache),
      "alpha",
    );
    const next = await index.search(
      new PageReader(index.root, source, new SearchRuntime(0), cache),
      "beta gamma",
    );
    expect(next.results[0].id).toBe("a");
    expect(next.diagnostics.requests).toBe(0);
    const corrupt = {
      read: async (k: string, o: number, n: number) => {
        const b = Uint8Array.from(await source.read(k, o, n));
        b.fill(0);
        return b;
      },
    };
    await expect(
      index.search(new PageReader(index.root, corrupt), "alpha"),
    ).rejects.toThrow(/checksum/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("pipelines bodies after six headers while capping physical page buffers", async () => {
  const { gzipSync } = await import("node:zlib"),
    { crc32 } = await import("../src/format/codec.js");
  const compressed = gzipSync(Buffer.from("x")),
    page = new Uint8Array(65536);
  page.set(compressed);
  const root: any = {
    version: 1,
    generation: "a".repeat(64),
    count: 0,
    avgBody: 0,
    avgTitle: 0,
    pageBytes: 65536,
    objectPages: 1024,
    dictionary: [],
    objects: [{ name: "plan-0.bin", size: 12 * 65536, sha256: "" }],
    hotBytes: 0,
  };
  const refs: any[] = Array.from({ length: 12 }, (_, i) => [
    0,
    i * 65536,
    compressed.length,
    crc32(compressed),
    1,
  ]);
  for (const pipeline of [false, true]) {
    let headers = 0,
      release!: () => void,
      six!: () => void,
      twelve!: () => void;
    const bodies = new Promise<void>((r) => (release = r)),
      sixHeaders = new Promise<void>((r) => (six = r)),
      twelveHeaders = new Promise<void>((r) => (twelve = r));
    const source = {
      async open() {
        headers++;
        if (headers === 6) six();
        if (headers === 12) twelve();
        return { bytes: bodies.then(() => page) };
      },
      async read() {
        return (await this.open()).bytes;
      },
    };
    const reader = new PageReader(
        root,
        source,
        new SearchRuntime(0),
        undefined,
        undefined,
        pipeline,
      ),
      job = reader.readMany(refs as any, "pipeline-test");
    await sixHeaders;
    if (pipeline) {
      await twelveHeaders;
      expect(headers).toBe(12);
    } else expect(headers).toBe(6);
    release();
    expect(await job).toHaveLength(12);
  }
});

it("uses shared-cache hits without reserving unnecessary puts and stays below 1000 Cache API calls", async () => {
  const { gzipSync } = await import("node:zlib"),
    { crc32 } = await import("../src/format/codec.js");
  const compressed = gzipSync(Buffer.from("x")),
    page = new Uint8Array(65536);
  page.set(compressed);
  const root: any = {
    version: 1,
    generation: "a".repeat(64),
    count: 0,
    avgBody: 0,
    avgTitle: 0,
    pageBytes: 65536,
    objectPages: 1024,
    dictionary: [],
    objects: [{ name: "plan-0.bin", size: 1024 * 65536, sha256: "" }],
    hotBytes: 0,
  };
  let gets = 0,
    puts = 0,
    origin = 0;
  const reader = new PageReader(
    root,
    {
      read: async () => {
        origin++;
        return page;
      },
    },
    new SearchRuntime(0),
    {
      get: async () => {
        gets++;
        return page;
      },
      put: async () => {
        puts++;
      },
    },
  );
  for (let i = 0; i < 1000; i += 50)
    await reader.readMany(
      Array.from(
        { length: 50 },
        (_, j) =>
          [0, (i + j) * 65536, compressed.length, crc32(compressed), 1] as [
            number,
            number,
            number,
            number,
            number,
          ],
      ),
      "cache-budget",
    );
  expect(gets).toBe(960);
  expect(puts).toBe(0);
  expect(origin).toBe(40);
  await expect(
    reader.readMany(
      [
        [0, 0, compressed.length, crc32(compressed), 8 * 1048576],
        [0, 65536, compressed.length, crc32(compressed), 8 * 1048576],
      ],
      "oversize",
    ),
  ).rejects.toThrow(/expanded batch/);
  expect(origin).toBe(40);
});

it("uploads immutable generation objects and rejects conflicting writes", async () => {
  const uploader = (await import("../src/global/upload-worker.js")).default;
  const values = new Map<string, any>(),
    generation = "a".repeat(64),
    key = generation + "/plan-0.bin",
    sha = "b".repeat(64);
  const env: any = {
    UPLOAD_TOKEN: "secret",
    INDEX: {
      head: async (k: string) => values.get(k),
      put: async (k: string, body: ReadableStream, options: any) => {
        const bytes = await new Response(body).arrayBuffer();
        values.set(k, {
          size: bytes.byteLength,
          customMetadata: options.customMetadata,
        });
      },
    },
  };
  const call = (method: string, hash = sha, auth = "secret") =>
    uploader.fetch(
      new Request("https://upload/" + key, {
        method,
        headers: {
          authorization: "Bearer " + auth,
          "content-length": "3",
          "x-sha256": hash,
        },
        body: method === "PUT" ? "abc" : undefined,
      }),
      env,
    );
  expect((await call("PUT", sha, "wrong")).status).toBe(404);
  expect((await call("HEAD")).status).toBe(404);
  expect((await call("PUT")).status).toBe(200);
  expect((await call("PUT")).status).toBe(200);
  expect((await call("PUT", "c".repeat(64))).status).toBe(409);
  const existing = await call("HEAD");
  expect(existing.headers.get("x-sha256")).toBe(sha);
  expect(existing.headers.get("x-generation")).toBe(generation);
});

it("shares origin and Cache API budgets across readers without resetting them on clearTrace", async () => {
  const { gzipSync } = await import("node:zlib"),
    { crc32 } = await import("../src/format/codec.js");
  const compressed = gzipSync(Buffer.from("x")),
    page = new Uint8Array(65536);
  page.set(compressed);
  const root: Root = {
    version: 1,
    generation: "a".repeat(64),
    count: 0,
    avgBody: 0,
    avgTitle: 0,
    pageBytes: 65536,
    objectPages: 1024,
    dictionary: [],
    objects: [{ name: "plan-0.bin", size: 65536, sha256: "" }],
    hotBytes: 0,
  };
  const ref: Address = [0, 0, compressed.length, crc32(compressed), 1];
  const budget = new ReadBudget(),
    traceStart = budget.traceStart;
  budget.requests = 7998;
  budget.cacheOperations = 958;
  let gets = 0,
    puts = 0,
    origins = 0;
  const source = {
      read: async () => {
        origins++;
        return page;
      },
    },
    cache = {
      get: async () => {
        gets++;
        return undefined;
      },
      put: async () => {
        puts++;
      },
    };
  const first = new PageReader(
      root,
      source,
      new SearchRuntime(0),
      cache,
      undefined,
      true,
      "adaptive960",
      budget,
    ),
    second = new PageReader(
      { ...root, generation: "b".repeat(64) },
      source,
      new SearchRuntime(0),
      cache,
      undefined,
      true,
      "adaptive960",
      budget,
    );
  await first.readMany([ref], "first-reader");
  expect(first.rounds).toHaveLength(1);
  expect(budget.requests).toBe(7999);
  expect(budget.cacheOperations).toBe(960);
  first.clearTrace();
  expect(first.rounds).toEqual([]);
  expect(budget.requests).toBe(7999);
  expect(budget.cacheOperations).toBe(960);
  expect(budget.traceStart).toBe(traceStart);
  await second.readMany([ref], "second-reader");
  expect(budget.requests).toBe(8000);
  second.clearTrace();
  await expect(second.readMany([ref], "exhausted")).rejects.toThrow(
    "Global storage request budget exceeded",
  );
  expect(gets).toBe(1);
  expect(puts).toBe(1);
  expect(origins).toBe(2);
});
