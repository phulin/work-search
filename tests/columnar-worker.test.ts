import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import "../scripts/workerd-runtime.js";
import { buildColumnar } from "../bench/columnar/control/offline-build.js";
it.each(["bundled", "metadata"])(
  "serves exact complete responses with %s integrity directories through workerd R2 and validated shared pages",
  async (integrity) => {
    const dir = await mkdtemp(join(tmpdir(), "cws-worker-"));
    let mf: Miniflare | undefined;
    try {
      const input = dir + "/input";
      await writeFile(
        input,
        Array.from({ length: 600 }, (_, i) =>
          JSON.stringify({
            id: "d" + i,
            title: "Court",
            body:
              i % 3
                ? "clear and convincing evidence"
                : "clear gap and convincing evidence",
            metadata: { i },
          }),
        ).join("\n"),
      );
      const root = await buildColumnar({ input, out: dir + "/index" });
      const crc = new Map(
        root.objects.map((o) => [
          o.name,
          Buffer.from(Uint32Array.from(o.checksums!).buffer).toString("base64"),
        ]),
      );
      if (integrity === "metadata") {
        root.objects = root.objects.map(({ checksums, ...o }) => o);
        await writeFile(dir + "/index/root.json", JSON.stringify(root));
      }
      await writeFile(
        dir + "/entry.ts",
        `import root from './index/root.json';import {createColumnarWorker}from ${JSON.stringify(resolve("src/columnar/worker.ts"))};export default createColumnarWorker(root);`,
      );
      await writeFile(
        dir + "/wrangler.json",
        JSON.stringify({
          name: "cws-worker-test",
          main: dir + "/entry.ts",
          compatibility_date: "2026-11-01",
        }),
      );
      const dry = spawnSync(
        "yarn",
        [
          "wrangler",
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
      mf = new Miniflare({
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        modules: true,
        modulesRoot: dir,
        scriptPath: dir + "/dist/entry.js",
        r2Buckets: ["INDEX"],
        bindings: { INTERNAL_TOKEN: "test", PAGE_CACHE: "1" },
      });
      const bucket = await mf.getR2Bucket("INDEX");
      for (const object of root.objects)
        await bucket.put(
          root.generation + "/" + object.name,
          await readFile(dir + "/index/packs/" + object.name),
          {
            sha256: object.sha256,
            customMetadata: {
              generation: root.generation,
              sha256: object.sha256,
              crc32: crc.get(object.name)!,
            },
          },
        );
      const call = async (body: unknown, auth = true) => {
        const r = await mf!.dispatchFetch("http://test/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: "Bearer test" } : {}),
          },
          body: JSON.stringify(body),
        });
        return { status: r.status, body: (await r.json()) as any };
      };
      const first = await call({
        q: '"clear and convincing evidence"',
        resetMemory: true,
        exactTotal: true,
      });
      expect(first.status).toBe(200);
      expect(first.body.results).toHaveLength(20);
      expect(first.body.total).toBe(400);
      const negative = await call({
        q: 'clear AND NOT "clear and"',
        exactTotal: true,
        limit: 2,
      });
      expect(negative.status).toBe(200);
      expect(negative.body.total).toBe(200);
      expect(negative.body.results).toHaveLength(2);
      expect(
        first.body.results.every((r: any) =>
          r.snippet.includes("clear and convincing evidence"),
        ),
      ).toBe(true);
      expect(first.body.diagnostics.requests).toBeGreaterThan(0);
      // Cache API writes are deferred; wait for their completion before asserting a warm cache.
      for (let i = 0; i < 2; i++)
        await call({ q: '"clear and convincing evidence"', resetMemory: true });
      const repeated = await call({
        q: '"clear and convincing evidence"',
        resetMemory: true,
      });
      expect(repeated.body.results).toEqual(first.body.results);
      expect(repeated.body.diagnostics.requests).toBe(0);
      expect(repeated.body.diagnostics.sharedGets).toBeGreaterThan(0);
      expect(repeated.body.diagnostics.applicationReset).toBe(true);
      expect(repeated.body.telemetry.isolate).toBe(
        first.body.telemetry.isolate,
      );
      expect(repeated.body.telemetry.requestId).not.toBe(
        first.body.telemetry.requestId,
      );
      const cursor = first.body.results.at(-1),
        next = await call({
          q: '"clear and convincing evidence"',
          after: { doc: cursor.doc, score: cursor.score },
          generation: root.generation,
        });
      expect(next.status).toBe(200);
      expect(
        next.body.results.some((r: any) =>
          first.body.results.some((p: any) => p.id === r.id),
        ),
      ).toBe(false);
      expect(
        (
          await call({
            q: "clear",
            after: { score: 1, doc: 1 },
            generation: "bad",
          })
        ).status,
      ).toBe(409);
      expect((await call({ q: "clear", limit: 101 })).status).toBe(400);
      expect(
        (await call({ q: "court", field: "title" })).body.results.every(
          (r: any) => r.snippet === "Court",
        ),
      ).toBe(true);
      expect(
        (await call({ q: "clear" }, false)).body.diagnostics,
      ).toBeUndefined();
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => call({ q: "clear evidence" })),
      );
      expect(
        concurrent.every((r) => r.status === 200 || r.status === 503),
      ).toBe(true);
      expect(concurrent.some((r) => r.status === 200)).toBe(true);
      for (const r of concurrent)
        if (r.status === 200) expect(r.body.results).toHaveLength(20);
        else expect(r.body.error).toBe("Search capacity busy");
      const bad = root.objects[0];
      await bucket.put(
        root.generation + "/" + bad.name,
        new Uint8Array(bad.size),
        { customMetadata: { generation: "f".repeat(64) } },
      );
      expect(
        (
          await call({
            q: "clear",
            resetMemory: true,
            cacheNamespace: "different",
          })
        ).status,
      ).toBe(503);
    } finally {
      if (mf) await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
