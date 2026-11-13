import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import "../scripts/workerd-runtime.js";
import { gzipSync } from "node:zlib";
import {
  assembleTermDirectory,
  TermDirectory,
} from "../src/columnar/term-directory.js";
import { crc32 } from "../src/format/codec.js";
import { u32 } from "../src/columnar/format.js";
import { generationFor } from "../src/columnar/construction/runs.js";
import { DocumentPackage } from "../src/columnar/document-package.js";
import {
  encodeDocumentDirectory,
  DocumentDirectory,
} from "../src/columnar/document-directory.js";
import { ColumnarR2 } from "../src/columnar/r2.js";
import { Reader } from "../src/columnar/storage.js";
import { PairStatistics } from "../src/columnar/construction/pair-statistics.js";
import { PairPacket } from "../src/columnar/pair-packet.js";
it("builds and searches from actual Worker R2 bindings, survives retry and refuses changed task inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-construction-"));
  let mf: Miniflare | undefined;
  try {
    const generation = "a".repeat(64),
      sourceRoot = {
        format: "R2-source-v1",
        documents: 256,
        parts: [
          {
            part: 0,
            generation,
            first: 0,
            count: 256,
            inputSha256: "b".repeat(64),
          },
        ],
      };
    await writeFile(
      dir + "/entry.ts",
      `import uploadWorker from ${JSON.stringify(resolve("src/columnar/upload-worker.ts"))};import {createConstructionWorker} from ${JSON.stringify(resolve("src/columnar/construction/worker.ts"))};import {TermDirectory} from ${JSON.stringify(resolve("src/columnar/term-directory.ts"))};import {ColumnarIndex} from ${JSON.stringify(resolve("src/columnar/search.ts"))};import {Reader} from ${JSON.stringify(resolve("src/columnar/storage.ts"))};import {ColumnarR2} from ${JSON.stringify(resolve("src/columnar/r2.ts"))};const worker=createConstructionWorker(${JSON.stringify(sourceRoot)} as any,'test-code');export default {async fetch(request,env){if(new URL(request.url).pathname==='/__verify-packages')return uploadWorker.fetch(request,{...env,UPLOAD_TOKEN:'test'});if(new URL(request.url).pathname==='/test-search'){const {root,q,directory,options}=await request.json();return Response.json(await new ColumnarIndex(root,undefined,directory?new TermDirectory(Uint8Array.from(directory),root.count):undefined).search(q,new Reader(root,new ColumnarR2(env.INDEX)),options));}return worker.fetch(request,env);}};`,
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
    for (let i = 0; i < 256; i++) {
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
    const first = await call("/ingest", {
        first: 0,
        count: 128,
        task: "retry",
      }),
      second = await call("/ingest", { first: 0, count: 128, task: "retry" });
    expect(second.output).toEqual(first.output);
    expect(second.reused).toBe(true);
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        call("/ingest", { first: i, count: 1 }),
      ),
    );
    expect(concurrent.every((r) => r.output.count === 1)).toBe(true);
    expect(concurrent.some((r) => r.telemetry.queueMs > 0)).toBe(true);
    await call("/ingest", { first: 1, count: 128, task: "retry" }, 500);
    const other = await call("/ingest", { first: 128, count: 128 }),
      a = first.output,
      b = other.output,
      merged = await call("/merge", { runs: [a, b] });
    expect(merged.output.state.done).toBe(true);
    const run = {
        first: 0,
        next: 256,
        count: 256,
        bodyTokens: a.bodyTokens + b.bodyTokens,
        titleTokens: a.titleTokens + b.titleTokens,
        chunks: merged.output.chunks,
      },
      root: any = {
        format: "CWS1",
        generation: "c".repeat(64),
        corpusHash: "b".repeat(64),
        count: 256,
        avgBody: run.bodyTokens / 256,
        avgTitle: run.titleTokens / 256,
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
    const packageGeneration = "d".repeat(64),
      packageInput = {
        rootRef: staged.output,
        vocabularyRef: vocabulary.output.vocabulary,
        generation: packageGeneration,
        first: 0,
        count: root.count,
      };
    const packageTask = "packages-first",
      packaged = await call("/package-documents", {
        ...packageInput,
        task: packageTask,
      });
    expect(packaged.output.end).toBe(root.count);
    await call("/package-documents", packageInput);
    const packageObject = await bucket.get(`${packageGeneration}/plan-7.bin`);
    expect(packageObject?.customMetadata?.generation).toBe(packageGeneration);
    const packet = new DocumentPackage(
      new Uint8Array(await packageObject!.arrayBuffer()),
      7,
    );
    expect((await packet.display()).id).toBe("d7");
    expect(await packet.snippet(new Set(), 600)).toContain("rare alpha beta");
    const groups = [];
    for (let first = 0; first < 256; first += 128) {
      const group = await call("/grouped-documents", {
        ...packageInput,
        first,
        count: 128,
      });
      expect(group.output.end).toBe(first + 128);
      expect(group.writesAndMergeReads).toBeLessThan(10);
      groups.push({
        ...group.output.group,
        offsets: Uint8Array.from(
          Buffer.from(group.output.group.offsets, "base64"),
        ),
      });
    }
    const docDirectory = new DocumentDirectory(
        encodeDocumentDirectory(groups, 256),
      ),
      groupReader = new Reader(root, new ColumnarR2(bucket as any));
    for (const doc of [0, 7, 127, 128, 255]) {
      const grouped = await groupReader.document(
        packageGeneration,
        doc,
        docDirectory.lookup(doc),
      );
      expect((await grouped.display()).id).toBe(`d${doc}`);
      if (doc === 7)
        expect(await grouped.snippet(new Set(), 600)).toContain(
          "rare alpha beta",
        );
    }
    expect(groupReader.stats.requests).toBe(5);
    const packetRoot = {
      ...root,
      objects: [] as any[],
      documents: [],
      hot: {},
      dictionaries: [],
      documentPackages: {
        generation: packageGeneration,
        count: 256,
        averageBytes: packaged.output.bytes / 256,
        bytes: packaged.output.bytes,
      },
    };
    let packetTerms: any, packetPrevious: string | undefined;
    const directoryBlocks = [];
    do {
      const current = "packets-" + task;
      packetTerms = await call("/packet-terms", {
        task: current,
        rootRef: staged.output,
        fences: root.dictionaries,
        objectBase: packetRoot.objects.length,
        stateTask: packetPrevious,
        byteBudget: 1,
      });
      packetRoot.objects.push(...packetTerms.output.objects);
      for (const block of packetTerms.output.blocks) {
        const obj = await bucket.get(block.ref.key);
        expect(obj).not.toBeNull();
        directoryBlocks.push({
          ...block,
          data: new Uint8Array(await obj!.arrayBuffer()),
        });
      }
      packetPrevious = current;
    } while (!packetTerms.output.state.done);
    const directory = assembleTermDirectory(directoryBlocks),
      bundled = new TermDirectory(directory, root.count),
      words = await bundled.lookup(["alpha", "beta", "rare", "court", "gap"]);
    expect(words.get("alpha")!.bodyOccurrences).toBe(256);
    expect(words.get("rare")!.df).toBe(1);
    const common = [...words.values()].map((t) => ({ id: t.id })),
      commonRef = await call("/stage", {
        value: { documents: 256, terms: common },
      }),
      statistics = [];
    for (const group of groups)
      statistics.push(
        (
          await call("/pair-statistics", {
            vocabularyRef: commonRef.output,
            group: {
              ...group,
              offsets: Buffer.from(group.offsets).toString("base64"),
            },
          })
        ).output,
      );
    const combined = await call("/merge-pair-statistics", { runs: statistics }),
      statsObject = await bucket.get(combined.output.chunks[0].key),
      stats = new PairStatistics(
        new Uint8Array(await statsObject!.arrayBuffer()),
      ),
      aRank = common.findIndex((t) => t.id === words.get("alpha")!.id),
      bRank = common.findIndex((t) => t.id === words.get("beta")!.id),
      gRank = common.findIndex((t) => t.id === words.get("gap")!.id);
    expect(stats.first).toBe(0);
    expect(stats.end).toBe(256);
    const counts = new Map(
      Array.from({ length: stats.count }, (_, i) => [
        stats.key(i),
        [stats.df(i), stats.occurrences(i)],
      ]),
    );
    expect(counts.get(aRank * common.length + bRank)).toEqual([1, 1]);
    expect(counts.get(aRank * common.length + gRank)).toEqual([255, 255]);
    await call(
      "/merge-pair-statistics",
      { runs: [statistics[0], statistics[0]] },
      500,
    );
    const selection = await call("/stage", {
        value: {
          documents: 256,
          terms: common,
          pairs: [
            {
              key: aRank * common.length + bRank,
              a: words.get("alpha")!.id,
              b: words.get("beta")!.id,
              df: 1,
              occurrences: 1,
              cost: 1000000,
            },
            {
              key: aRank * common.length + gRank,
              a: words.get("alpha")!.id,
              b: words.get("gap")!.id,
              df: 255,
              occurrences: 255,
              cost: 1000000,
            },
          ],
        },
      }),
      pairRuns = [];
    for (const group of groups)
      pairRuns.push(
        ...(
          await call("/pair-occurrences", {
            selectionRef: selection.output,
            group: {
              ...group,
              offsets: Buffer.from(group.offsets).toString("base64"),
            },
          })
        ).output.runs,
      );
    const mergedPairs = await call("/merge-pair-occurrences", {
        runs: pairRuns,
      }),
      finishedPairs = await call("/finish-pairs", {
        selectionRef: selection.output,
        run: mergedPairs.output.run,
        objectBase: packetRoot.objects.length,
      });
    expect(finishedPairs.output.coverage.documents).toBe(256);
    expect(finishedPairs.output.coverage.pairs).toBe(2);
    expect(finishedPairs.output.coverage.occurrences).toBe(256);
    const descriptor =
        finishedPairs.output.descriptors[
          `${words.get("alpha")!.id}:${words.get("beta")!.id}`
        ],
      object =
        finishedPairs.output.objects[
          descriptor.ref[0] - packetRoot.objects.length
        ],
      pairObject = await bucket.get(object.key),
      pairBytes = new Uint8Array(await pairObject!.arrayBuffer()),
      pairPacket = new PairPacket(
        pairBytes.subarray(
          descriptor.ref[1],
          descriptor.ref[1] + descriptor.ref[2],
        ),
      );
    expect([...pairPacket.docs]).toEqual([7]);
    expect([
      ...pairPacket.phrase(
        0,
        0,
        [words.get("rare")!.id, words.get("alpha")!.id, words.get("beta")!.id],
        1,
      ).starts,
    ]).toEqual([600]);
    packetRoot.generation = await generationFor(packetRoot);
    const coverage = await call("/__verify-packages", {
      task: "coverage-0",
      generation: packageGeneration,
      tasks: [packageTask],
    });
    expect(coverage.documents).toBe(root.count);
    await call(
      "/__verify-packages",
      {
        task: "coverage-bad",
        generation: packageGeneration,
        tasks: [packageTask, packageTask],
      },
      400,
    );
    await call(
      "/__verify-packages",
      {
        task: "coverage-bad",
        generation: "e".repeat(64),
        tasks: [packageTask],
      },
      400,
    );
    const packetVerifications = [];
    for (let first = 0; first < packetRoot.objects.length; first += 256) {
      const task = "packet-verify-" + first;
      await call("/verify", { task, root: packetRoot, first });
      packetVerifications.push(task);
    }
    await call(
      "/publish",
      {
        root: packetRoot,
        verifications: packetVerifications,
        packageVerifications: ["coverage-bad"],
      },
      500,
    );
    await call("/publish", {
      root: packetRoot,
      verifications: packetVerifications,
      packageVerifications: ["coverage-0"],
    });
    for (const q of [
      '"alpha beta"',
      "rare",
      "alpha NOT rare",
      'NOT "alpha beta"',
      "court OR rare",
    ]) {
      const result = await call("/test-search", {
        root: packetRoot,
        directory: [...directory],
        q,
        options: { exactTotal: true },
      });
      const expected =
        q === '"alpha beta"' || q === "rare"
          ? 1
          : q === "court OR rare"
            ? 256
            : 255;
      expect(result.total, q).toBe(expected);
      if (q === '"alpha beta"') {
        expect(result.results[0].id).toBe("d7");
        expect(result.results[0].snippet).toContain("alpha beta");
      }
    }
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
