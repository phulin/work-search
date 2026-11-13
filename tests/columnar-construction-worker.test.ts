import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import "../scripts/workerd-runtime.js";
import { gzipSync } from "node:zlib";
import { crc32 } from "../src/format/codec.js";
import { u32 } from "../src/columnar/format.js";
import { generationFor } from "../src/columnar/construction/runs.js";
it("builds and searches from actual Worker R2 bindings, survives retry and refuses changed task inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-construction-"));
  let mf: Miniflare | undefined;
  try {
    const generation = "a".repeat(64),
      sourceRoot = {
        format: "R2-source-v1",
        documents: 12,
        parts: [
          {
            part: 0,
            generation,
            first: 0,
            count: 12,
            inputSha256: "b".repeat(64),
          },
        ],
      };
    await writeFile(
      dir + "/entry.ts",
      `import {createConstructionWorker} from ${JSON.stringify(resolve("src/columnar/construction/worker.ts"))};import {ColumnarIndex} from ${JSON.stringify(resolve("src/columnar/search.ts"))};import {Reader} from ${JSON.stringify(resolve("src/columnar/storage.ts"))};import {ColumnarR2} from ${JSON.stringify(resolve("src/columnar/r2.ts"))};const worker=createConstructionWorker(${JSON.stringify(sourceRoot)} as any,'test-code');export default {async fetch(request,env){if(new URL(request.url).pathname==='/test-search'){const {root,q}=await request.json();return Response.json(await new ColumnarIndex(root).search(q,new Reader(root,new ColumnarR2(env.INDEX))));}return worker.fetch(request,env);}};`,
    );
    await writeFile(
      dir + "/wrangler.json",
      JSON.stringify({
        name: "cws-construction-test",
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
      modules: true,
      modulesRoot: dir,
      scriptPath: dir + "/dist/entry.js",
      r2Buckets: ["INDEX"],
      bindings: { INTERNAL_TOKEN: "test" },
    });
    const bucket = await mf.getR2Bucket("INDEX"),
      pointers: number[] = [];
    for (let i = 0; i < 12; i++) {
      const content = gzipSync(
          i === 7 ? "a ".repeat(600) + "rare alpha beta" : "alpha gap beta",
        ),
        info = new TextEncoder().encode(
          JSON.stringify({ id: `d${i}`, title: "Court", metadata: { i } }),
        );
      for (const [name, bytes] of [
        [`content-${i}.bin`, content],
        [`info-${i}.bin`, info],
      ] as const)
        await bucket.put(generation + "/" + name, bytes, {
          customMetadata: { generation },
        });
      pointers.push(
        i,
        0,
        content.length,
        crc32(content),
        i,
        0,
        info.length,
        crc32(info),
      );
    }
    await bucket.put(generation + "/contentmap-0.bin", u32(pointers), {
      customMetadata: { generation },
    });
    let task = 0;
    const call = async (path: string, input: any = {}, expected = 200) => {
      const response = await mf!.dispatchFetch("http://test" + path, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            build: "test",
            task: `task-${task++}`,
            ...input,
          }),
        }),
        body = (await response.json()) as any;
      expect(response.status, JSON.stringify(body)).toBe(expected);
      return body;
    };
    const first = await call("/ingest", { first: 0, count: 6, task: "retry" }),
      second = await call("/ingest", { first: 0, count: 6, task: "retry" });
    expect(second.output).toEqual(first.output);
    expect(second.reused).toBe(true);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call("/ingest", { first: i, count: 1 }),
      ),
    );
    expect(concurrent.every((r) => r.output.count === 1)).toBe(true);
    expect(concurrent.some((r) => r.telemetry.queueMs > 0)).toBe(true);
    await call("/ingest", { first: 1, count: 6, task: "retry" }, 500);
    const other = await call("/ingest", { first: 6, count: 6 }),
      a = first.output,
      b = other.output,
      merged = await call("/merge", { runs: [a, b] });
    expect(merged.output.state.done).toBe(true);
    const run = {
        first: 0,
        next: 12,
        count: 12,
        bodyTokens: a.bodyTokens + b.bodyTokens,
        titleTokens: a.titleTokens + b.titleTokens,
        chunks: merged.output.chunks,
      },
      root: any = {
        format: "CWS1",
        generation: "c".repeat(64),
        corpusHash: "b".repeat(64),
        count: 12,
        avgBody: run.bodyTokens / 12,
        avgTitle: run.titleTokens / 12,
        documents: [[0, 0, 0]],
        objects: [],
        hot: {},
        dictionaries: [],
      };
    let final: any, previous: string | undefined;
    do {
      const current = "posting-" + task;
      final = await call("/postings", {
        task: current,
        run,
        statistics: {
          count: root.count,
          avgBody: root.avgBody,
          avgTitle: root.avgTitle,
        },
        objectBase: root.objects.length,
        stateTask: previous,
        compact: true,
        byteBudget: 100,
      });
      root.objects.push(...final.output.objects);
      previous = current;
      expect(final.output.state.term).toBeUndefined();
    } while (!final.output.state.done);
    root.hot = Object.fromEntries(final.output.state.hot);
    root.dictionaries = final.output.state.dictionaries.at(-1);
    root.dictionaryHeight = final.output.state.dictionaries.length - 1;
    const staged = await call("/stage", {
      value: {
        ...root,
        idRouting: {
          dictionaries: final.output.state.ids.dictionaries.at(-1),
          dictionaryHeight: final.output.state.ids.dictionaries.length - 1,
        },
      },
    });
    const vocabulary = await call("/vocabulary", {
      rootRef: staged.output,
      first: 0,
      count: root.count,
    });
    let documents: any;
    previous = undefined;
    do {
      const current = "document-" + task;
      documents = await call("/documents", {
        task: current,
        documentRoot: { generation: root.generation, count: root.count },
        vocabularyRef: vocabulary.output.vocabulary,
        objectBase: root.objects.length,
        stateTask: previous,
        compact: true,
        tokenBudget: 4,
      });
      root.objects.push(...documents.output.objects);
      previous = current;
      expect(documents.output.state.pending).toBeUndefined();
    } while (!documents.output.done);
    root.documents = documents.output.state.documents;
    await call("/publish", { root }, 500);
    root.generation = await generationFor(root);
    await call("/publish", { root }, 500);
    const verifications = [];
    for (let first = 0; first < root.objects.length; first += 256) {
      const current = "verify-" + first;
      await call("/verify", { task: current, root, first });
      verifications.push(current);
    }
    await call("/publish", { root, verifications: ["missing"] }, 500);
    const changed = structuredClone(root);
    changed.objects[0].sha256 = "e".repeat(64);
    changed.generation = await generationFor(changed);
    await call("/publish", { root: changed, verifications }, 500);
    await call("/publish", { root, verifications });
    expect(
      (await bucket.get(root.generation + "/root.json"))?.size,
    ).toBeGreaterThan(0);
    const result = await call("/test-search", { root, q: '"alpha beta"' });
    expect(result.results.map((r: any) => r.id)).toEqual(["d7"]);
    expect(result.results[0].snippet).toContain("alpha beta");
    expect(result.results[0].metadata).toEqual({ i: 7 });
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
