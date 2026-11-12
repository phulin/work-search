import { it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  encodeRoutes,
  encodeRoutePage,
  ROUTE_BUCKETS,
} from "../src/format/routes.js";
import { crc32 } from "../src/format/codec.js";
it("runs the demo Data module and gzip routing reader in workerd against native R2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "demo-routes-"));
  let mf: Miniflare | undefined;
  try {
    const config = join(dir, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "test-demo-routes",
        main: resolve("demo/gateway.ts"),
        compatibility_date: "2026-11-01",
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      }),
    );
    const dry = spawnSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "deploy",
        "--config",
        config,
        "--dry-run",
        "--outdir",
        dir + "/dist",
      ],
      { encoding: "utf8" },
    );
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    const script = dir + "/dist/gateway.js",
      text = await readFile(script, "utf8"),
      name = text.match(/["']\.\/([^"']+\.bin)["']/)![1],
      generation = "a".repeat(64),
      shardGeneration = "b".repeat(64),
      page = gzipSync(encodeRoutePage([]));
    const binary = encodeRoutes({
      version: 1,
      generation,
      shards: { 0: shardGeneration },
      hot: [],
      pages: Array.from({ length: ROUTE_BUCKETS }, () => ({
        object: 0,
        offset: 0,
        length: page.length,
        crc: crc32(page),
      })),
    });
    const calls: any[] = [];
    mf = new Miniflare({
      modules: [
        { type: "ESModule", path: script },
        { type: "Data", path: dir + "/dist/" + name, contents: binary },
      ],
      modulesRoot: dir,
      scriptPath: script,
      r2Buckets: ["INDEX"],
      bindings: {
        ROLE: "root",
        PERF_LEVEL: "3",
        INTERNAL_TOKEN: "test",
        CHILDREN: JSON.stringify([{ binding: "PART", min: 0, max: 0 }]),
      },
      serviceBindings: {
        PART: async (request: any) => {
          const b: any = await request.json();
          calls.push({ path: new URL(request.url).pathname, b });
          return Response.json(
            new URL(request.url).pathname.endsWith("/stats")
              ? {
                  apiVersion: 2,
                  count: 10,
                  bodyTokens: 20,
                  titleTokens: 0,
                  df: {},
                  generations: { 0: shardGeneration },
                }
              : { results: [] },
          );
        },
      },
    });
    const bucket = await mf.getR2Bucket("INDEX");
    await bucket.put(generation + "/routes-0.bin", page, {
      customMetadata: { generation },
    });
    const response = await mf.dispatchFetch("https://demo/api/search?q=absent");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [], documents: 10 });
    expect(calls.map((c) => c.path)).toEqual(["/internal/stats"]);
    const negative = await mf.dispatchFetch(
      "https://demo/api/search?q=NOT+absent",
    );
    expect(negative.status).toBe(200);
    expect(calls.at(-1).path).toBe("/internal/search");
    expect(calls.at(-1).b.termHints).toEqual({ 0: { absent: null } });
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
