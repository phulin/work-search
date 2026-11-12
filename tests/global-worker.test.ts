import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { buildGlobal } from "../src/global/build.js";
import { GlobalIndex } from "../src/global/search.js";
import { PageReader } from "../src/global/storage.js";
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
          body: "clear and convincing evidence case " + i,
          metadata: { court: "Test court" },
        }),
      ).join("\n"),
    );
    const manifest = await buildGlobal({
      input: dir + "/input",
      out: dir + "/index",
      budgets: [1048576],
    });
    await writeFile(
      dir + "/entry.ts",
      `import bytes from './index/bundle-1.bin';import {createGlobalWorker} from ${JSON.stringify(resolve("src/global/worker-runtime.ts"))};export default createGlobalWorker(new Uint8Array(bytes));`,
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
      name = text.match(/["']\.\/([^"']+\.bin)["']/)![1];
    mf = new Miniflare({
      modules: [
        { type: "ESModule", path: script },
        {
          type: "Data",
          path: dir + "/dist/" + name,
          contents: await readFile(dir + "/index/bundle-1.bin"),
        },
      ],
      modulesRoot: dir,
      scriptPath: script,
      r2Buckets: ["INDEX"],
      bindings: {
        PAGE_CACHE: "1",
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
    const r = await mf.dispatchFetch("https://search/search", {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: JSON.stringify({ q: '"clear and convincing evidence"', limit: 20 }),
    });
    expect(r.status).toBe(200);
    const first: any = await r.json();
    expect(first.results).toHaveLength(20);
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
