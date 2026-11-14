import { gunzipSync } from "node:zlib";
import { view, refAt } from "../src/columnar/format.js";
import { buildMetadata } from "../scripts/build-columnar-metadata.js";
import { ColumnarIndex } from "../src/columnar/search.js";
import { Reader } from "../src/columnar/storage.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import {
  encodePairMembership,
  encodePairMembershipPacket,
} from "../src/columnar/pair-membership.js";
import { encodePairRouter } from "../src/columnar/pair-router.js";
import { u32 } from "../src/columnar/format.js";
import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import "../scripts/workerd-runtime.js";
import { buildColumnar } from "../bench/columnar/control/offline-build.js";
it.each(["bundled", "metadata", "absent", "boolean"])(
  "serves exact complete responses with %s checksum directories through workerd R2 and generation-scoped shared pages",
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
      let membershipEntry = "",
        membershipArgument = "",
        membershipPacket: Uint8Array | undefined;
      const pairGeneration = "f".repeat(64);
      if (integrity === "boolean") {
        const objects = new OfflineObjects(dir + "/index", root),
          terms = await new ColumnarIndex(root).terms(
            ["clear", "gap", "and", "convincing", "evidence"],
            new Reader(root, objects.source),
          );
        await objects.close();
        const rows = new Map<
          string,
          { a: string; b: string; docs: number[] }
        >();
        for (let doc = 0; doc < 600; doc++) {
          const words = (
            doc % 3
              ? "clear and convincing evidence"
              : "clear gap and convincing evidence"
          ).split(" ");
          for (let i = 0; i + 1 < words.length; i++) {
            const a = words[i],
              b = words[i + 1],
              key = a + ":" + b;
            let entry = rows.get(key);
            if (!entry) {
              entry = { a, b, docs: [] };
              rows.set(key, entry);
            }
            entry.docs.push(doc);
          }
        }
        const data = [...rows.values()];
        membershipPacket = encodePairMembershipPacket(
          data.map((p) => ({
            a: p.a,
            b: p.b,
            data: encodePairMembership(
              {
                a: terms.get(p.a)!.id,
                b: terms.get(p.b)!.id,
                df: p.docs.length,
                body: Uint32Array.from(p.docs),
                title: new Uint32Array(),
                bodyOccurrences: p.docs.length,
                titleOccurrences: 0,
              },
              600,
            ),
          })),
        );
        const router = encodePairRouter(
          {
            generation: pairGeneration,
            baseGeneration: root.generation,
            documents: 600,
            targetBytes: 131072,
            contextBytes: 0,
            namespaces: [],
            roots: [-1],
            commonWords: [],
          },
          [],
          [
            {
              namespace: 0,
              bits: 0,
              prefix: 0,
              bytes: membershipPacket.length,
              crc32: 0,
              pairs: data.length,
            },
          ],
          encodePairMembershipPacket(
            data.map((p) => ({
              a: p.a,
              b: p.b,
              data: u32([p.docs.length, p.docs.length, 0, 100, 0]),
            })),
          ),
        );
        await writeFile(dir + "/router.bin", router);
        membershipEntry =
          'import routerBytes from "./router.bin";import {PairRouter}from ' +
          JSON.stringify(resolve("src/columnar/pair-router.ts")) +
          ";";
        membershipArgument =
          ",undefined,undefined,undefined,undefined,undefined,{router:new PairRouter(new Uint8Array(routerBytes)),N:0,M:0}";
      }
      const metadataManifest = await buildMetadata(
        root,
        { i: "number" },
        (async function* () {
          const files = new OfflineObjects(dir + "/index", root);
          try {
            const table = view(await files.read(root.documents[0]));
            for (let doc = 0; doc < 600; doc++)
              yield {
                doc,
                metadata: JSON.parse(
                  gunzipSync(
                    await files.read(refAt(table, doc * 36)),
                  ).toString(),
                ).metadata,
              };
          } finally {
            await files.close();
          }
        })(),
        dir + "/metadata",
        128,
      );
      await writeFile(dir + "/metadata.json", JSON.stringify(metadataManifest));
      const crc = new Map(
        root.objects.map((o) => [
          o.name,
          Buffer.from(Uint32Array.from(o.checksums!).buffer).toString("base64"),
        ]),
      );
      if (integrity !== "bundled") {
        root.objects = root.objects.map(({ checksums, ...o }) => o);
        await writeFile(dir + "/index/root.json", JSON.stringify(root));
      }
      await writeFile(
        dir + "/entry.ts",
        `import root from './index/root.json';import metadataManifest from './metadata.json';import {createColumnarWorker}from ${JSON.stringify(resolve("src/columnar/worker.ts"))};${membershipEntry}export default createColumnarWorker(root${membershipArgument || ",undefined,undefined,undefined,undefined,undefined,undefined"},metadataManifest);`,
      );
      await writeFile(
        dir + "/wrangler.json",
        JSON.stringify({
          name: "cws-worker-test",
          main: dir + "/entry.ts",
          compatibility_date: "2026-11-01",
          rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
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
        modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
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
              ...(integrity === "absent"
                ? {}
                : { crc32: crc.get(object.name)! }),
            },
          },
        );
      if (membershipPacket)
        await bucket.put(
          pairGeneration + "/pairs-0-0-0-0.bin",
          membershipPacket,
          { customMetadata: { generation: pairGeneration } },
        );
      for (const b of metadataManifest.blocks)
        for (const c of Object.values(b.columns))
          await bucket.put(
            c.key,
            await readFile(
              dir + "/metadata/objects/" + c.key.split("/")[0] + ".bin",
            ),
            {
              customMetadata: {
                generation: c.key.split("/")[0],
                sha256: c.key.split("/")[0],
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
      const filtered = await call({
        q: '"clear and convincing evidence"',
        exactTotal: true,
        filter: { field: "i", op: "gte", value: 590 },
      });
      expect(filtered.status).toBe(200);
      expect(filtered.body.total).toBe(7);
      expect(filtered.body.results.every((h: any) => h.metadata.i >= 590)).toBe(
        true,
      );
      expect(filtered.body.diagnostics.metadataFilterRejected).toBeGreaterThan(
        0,
      );
      expect(filtered.body.metadataGeneration).toBe(
        metadataManifest.generation,
      );
      const lastFiltered = filtered.body.results.at(-1),
        filteredCursor = { doc: lastFiltered.doc, score: lastFiltered.score };
      expect(
        (
          await call({
            q: '"clear and convincing evidence"',
            filter: { field: "i", op: "gte", value: 590 },
            after: filteredCursor,
            generation: root.generation,
            metadataGeneration: "wrong",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call({
            q: '"clear and convincing evidence"',
            filter: { field: "i", op: "gte", value: 590 },
            after: filteredCursor,
            generation: root.generation,
            metadataGeneration: metadataManifest.generation,
          })
        ).body.results,
      ).toHaveLength(0);
      const excluded = await call({
        q: "clear",
        filter: { field: "i", op: "gt", value: 1000 },
        exactTotal: true,
      });
      expect(excluded.body.total).toBe(0);
      expect(excluded.body.diagnostics.scoreBlocksFetched).toBe(0);
      const get = await mf!.dispatchFetch(
        "http://test/search?q=clear&filter=" +
          encodeURIComponent(
            JSON.stringify({ field: "i", op: "gte", value: 590 }),
          ),
      );
      expect(get.status).toBe(200);
      expect(((await get.json()) as any).results).toHaveLength(10);
      const badFilter = await call({
        q: "clear",
        filter: { field: "unknown", op: "eq", value: 1 },
      });
      expect(badFilter.status).toBe(400);
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
      if (integrity === "boolean")
        for (const q of [
          '"clear and" AND ("convincing evidence" OR "gap and")',
          '"clear and" /5 ("gap and" OR "convincing evidence")',
        ]) {
          const r = await call({ q, exactTotal: true, limit: 7 });
          expect(r.status).toBe(200);
          expect(r.body.total).toBe(400);
          expect(r.body.results).toHaveLength(7);
          expect(r.body.diagnostics.plannedPairPackets).toBeGreaterThan(1);
          expect(
            r.body.results.every((h: any) =>
              h.snippet.includes("clear and convincing evidence"),
            ),
          ).toBe(true);
        }
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
