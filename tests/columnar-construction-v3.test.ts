import { expect, it } from "vitest";
import {
  BuildStore,
  digest,
  jsonBytes,
  RunWriter,
  RunReader,
  termRecord,
  rowRecord,
  type Run,
} from "../src/columnar/construction/runs.js";
import {
  encodeRunBlock,
  decodeRunBlock,
} from "../src/columnar/construction/block-codec.js";
import { concat, pack, unpack } from "../src/columnar/format.js";
import {
  SummaryWriter,
  SummaryReader,
  mergeSummaries,
  type SummaryRun,
} from "../src/columnar/construction/term-summaries.js";
import {
  cataloguePartition,
  type Catalogue,
} from "../src/columnar/construction/catalogue.js";
import {
  finalMerge,
  type FinalMergeState,
} from "../src/columnar/construction/final-merge.js";
import { PairStatistics } from "../src/columnar/construction/pair-statistics.js";
import {
  pairStatisticsJob,
  pairOccurrencesJob,
} from "../src/columnar/construction/pair-jobs.js";
import { pairRunEntries } from "../src/columnar/construction/pair-occurrences.js";
import {
  encodeDocumentPackage,
  DocumentPackage,
} from "../src/columnar/document-package.js";
import {
  NumericWriter,
  numericDocuments,
} from "../src/columnar/construction/numeric-staging.js";
import { countedBucket } from "../src/columnar/construction/bucket.js";
import { decodeDirectoryBlock } from "../src/columnar/term-directory.js";
import { transformBlock } from "../src/columnar/construction/block-codec.js";
function fixture() {
  const objects = new Map<string, { raw: Uint8Array; metadata: any }>();
  const calls = { get: 0, put: 0, head: 0 };
  const bucket = {
    async put(key: string, raw: Uint8Array, options: any) {
      calls.put++;
      objects.set(key, {
        raw: Uint8Array.from(raw),
        metadata: options?.customMetadata,
      });
      return { size: raw.length };
    },
    async get(key: string, options: any) {
      calls.get++;
      const entry = objects.get(key);
      if (!entry) return null;
      const range = options?.range,
        data = range
          ? entry.raw.slice(range.offset, range.offset + range.length)
          : entry.raw;
      return {
        size: entry.raw.length,
        customMetadata: entry.metadata,
        range,
        arrayBuffer: async () => data.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(data)),
      };
    },
    async head(key: string) {
      calls.head++;
      const e = objects.get(key);
      return e && { size: e.raw.length, customMetadata: e.metadata };
    },
  } as unknown as R2Bucket;
  return { objects, calls, bucket, store: new BuildStore(bucket) };
}
it("roundtrips compressed staging, coalesces blocks with individual checksums, rejects corruption", async () => {
  const { store, objects, calls } = fixture();
  const rows = [
    termRecord("İ𐐀法院", 2),
    rowRecord(200, 11, 2, [1, 5, 9], [0]),
    rowRecord(500, 3000, 1, [2, 10], []),
    termRecord("𐐀", 1),
    rowRecord(0, 1, 0, [0], []),
  ];
  for (const codec of ["raw", "gzip", "delta-gzip-v3"] as const) {
    const raw = concat(rows),
      encoded = await encodeRunBlock(raw, codec);
    expect(await decodeRunBlock(encoded, codec, raw.length)).toEqual(raw);
  }
  const writer = new RunWriter(store, 60, undefined, 1048576, "delta-gzip-v3");
  for (const row of rows) await writer.append(row);
  await writer.finish();
  const before = calls.get,
    blocks = await store.getMany(writer.chunks);
  expect(calls.get - before).toBe(1);
  expect(
    concat(
      await Promise.all(
        blocks.map((b, i) =>
          decodeRunBlock(b, "delta-gzip-v3", writer.chunks[i].rawBytes),
        ),
      ),
    ),
  ).toEqual(concat(rows));
  objects.get(writer.chunks[0].key)!.raw[0] ^= 1;
  await expect(store.getMany(writer.chunks)).rejects.toThrow("checksum");
});
it("catalogue reduction and fused finalization preserve Unicode IDs, occurrences and common-term restart coverage", async () => {
  const { store, calls } = fixture(),
    runs: Run[] = [],
    summaries: SummaryRun[] = [];
  const words = ["a", "z", "法院", "𐐀"].sort();
  for (let first = 0; first < 260; first += 130) {
    const writer = new RunWriter(
        store,
        1024,
        undefined,
        1 << 20,
        "delta-gzip-v3",
      ),
      sw = new SummaryWriter(store, 2, 1 << 20);
    for (const word of words) {
      await writer.append(termRecord(word, 130));
      for (let doc = first; doc < first + 130; doc++)
        await writer.append(rowRecord(doc, 7, 2, [0, 2, 4], [0]));
      await sw.append({ word, df: 130, body: 390, title: 130 });
    }
    await writer.finish();
    runs.push({
      first,
      next: first + 130,
      count: 130,
      bodyTokens: 910,
      titleTokens: 260,
      chunks: writer.chunks,
    });
    summaries.push({
      version: 3,
      first,
      end: first + 130,
      chunks: await sw.finish(),
    });
  }
  let state: any,
    chunks: any[] = [],
    count = 0;
  do {
    const r = await mergeSummaries(store, summaries, state, 1);
    state = r.state;
    chunks.push(...r.chunks);
    count += r.count;
  } while (!state.done);
  expect(count).toBe(4);
  const run: SummaryRun = { version: 3, first: 0, end: 260, chunks },
    reader = new SummaryReader(store, run);
  for (const word of words) {
    expect(await reader.peek()).toEqual({
      word,
      df: 260,
      body: 780,
      title: 260,
    });
    reader.consume();
  }
  expect(await reader.peek()).toBeUndefined();
  const cp = await cataloguePartition(store, run, 1);
  expect(cp.state.done).toBe(true);
  expect(cp.count).toBe(4);
  const catalogue: Catalogue = {
    format: "construction-catalogue-v3",
    source: "a".repeat(64),
    documents: 260,
    bodyTokens: 1820,
    titleTokens: 520,
    terms: 4,
    partitions: [{ firstId: 1, count: 4, summaries: run }],
    words: cp.packets,
    hot: { count: 4, df: 1, lastId: 4 },
    pairTerms: [],
  };
  let saved: FinalMergeState | undefined,
    base = 0,
    terms: [string, any][] = [];
  do {
    const result = await finalMerge(
      store,
      runs,
      catalogue,
      "b".repeat(64),
      0,
      base,
      saved,
      1000,
    );
    saved = JSON.parse(JSON.stringify(result.state));
    base += 16384;
    for (const block of result.hot)
      terms.push(
        ...decodeDirectoryBlock(
          await transformBlock(await store.get(block.ref), true),
          260,
        ),
      );
  } while (!saved!.finish.done);
  expect(
    terms.map(([w, t]) => [
      w,
      t.id,
      t.df,
      t.bodyOccurrences,
      t.titleOccurrences,
    ]),
  ).toEqual(words.map((w, i) => [w, i + 1, 260, 780, 260]));
  expect(saved!.finish.dictionaries).toEqual([[]]);
  expect(saved!.finish.ids.dictionaries).toEqual([[]]);
  expect(calls.put).toBeLessThan(100);
  await expect(
    finalMerge(store, runs, catalogue, "c".repeat(64), 0, base, saved),
  ).rejects.toThrow("mismatch");
});
it("processes 257-document pair groups once per phase and preserves exact numeric staging coverage", async () => {
  const { store, calls } = fixture(),
    ids = new Map([
      ["a", 1],
      ["b", 2],
    ]),
    packets: Uint8Array[] = [],
    offsets = [0];
  const nw = new NumericWriter(store, 0, "c".repeat(64), 60, 1024);
  for (let doc = 0; doc < 257; doc++) {
    const packet = await encodeDocumentPackage(
      { doc, id: String(doc), body: "a b a b", title: "b a" },
      ids,
    );
    packets.push(packet);
    offsets.push(offsets.at(-1)! + packet.length);
    await nw.append({
      doc,
      body: Uint32Array.of(1, 2, 1, 2),
      title: Uint32Array.of(2, 1),
    });
  }
  const numeric = await nw.finish(),
    docs = [];
  for await (const d of numericDocuments(store, numeric, "c".repeat(64)))
    docs.push(d);
  expect(docs.map((d) => d.doc)).toEqual(
    Array.from({ length: 257 }, (_, i) => i),
  );
  const ref = await store.put(concat(packets), "plan-0.bin"),
    group = {
      first: 0,
      end: 257,
      sha256: ref.sha256,
      offsets: btoa(String.fromCharCode(...pack(offsets, true))),
    };
  const vocabularyRef = await store.put(
    jsonBytes({ documents: 257, terms: [{ id: 1 }, { id: 2 }] }),
  );
  const before = calls.get,
    stats = await pairStatisticsJob(store, { group, vocabularyRef });
  expect(calls.get - before).toBe(2);
  const result = new PairStatistics(await store.get(stats.chunks[0]));
  const i = Array.from({ length: result.count }, (_, i) => i).find(
    (i) => result.key(i) === 1,
  )!;
  expect([result.df(i), result.occurrences(i)]).toEqual([257, 514]);
  const selectionRef = await store.put(
    jsonBytes({
      documents: 257,
      terms: [{ id: 1 }, { id: 2 }],
      pairs: [{ key: 1, a: 1, b: 2, df: 257, occurrences: 514, cost: 1 << 20 }],
    }),
  );
  const beforeOccurrence = calls.get,
    output = await pairOccurrencesJob(store, { group, selectionRef });
  expect(calls.get - beforeOccurrence).toBe(2);
  expect(output.runs[0].first).toBe(0);
  expect(output.runs.at(-1)!.end).toBe(257);
  let matches = 0;
  for (const run of output.runs)
    for await (const row of pairRunEntries(store, run))
      matches += new (
        await import("../src/columnar/pair-packet.js")
      ).PairPacket(row.packet).docs.length;
  expect(matches).toBe(257);
});
it("accounts current operations and failed I/O separately", async () => {
  const f = fixture(),
    counted = countedBucket(f.bucket),
    store = new BuildStore(counted.bucket);
  const ref = await store.put(Uint8Array.of(1, 2, 3));
  await store.get(ref);
  await counted.bucket.head(ref.key);
  expect(counted.snapshot()).toEqual({
    operations: { put: 1, get: 1, head: 1 },
    failures: {},
    bytesRead: 3,
    bytesWritten: 3,
  });
  const fail = countedBucket({
    get: async () => {
      throw Error("failed");
    },
  } as any);
  await expect(fail.bucket.get("missing")).rejects.toThrow("failed");
  expect(fail.snapshot().failures).toEqual({ get: 1 });
});

it("builds a fresh searchable generation without vocabulary jobs, survives cold activation and receipt reuse", async () => {
  const { createFreshConstructionWorker } =
    await import("../src/columnar/construction/fresh-worker.js");
  const { crc32 } = await import("../src/format/codec.js");
  const { gzipSync } = await import("node:zlib");
  const { generationFor } =
    await import("../src/columnar/construction/runs.js");
  const { encodeDocumentDirectory, DocumentDirectory } =
    await import("../src/columnar/document-directory.js");
  const { TermDirectory, assembleTermDirectory, assembleTieredDirectory } =
    await import("../src/columnar/term-directory.js");
  const { ENGLISH_ANALYSIS } = await import("../src/query/analysis.js");
  const { ColumnarIndex } = await import("../src/columnar/search.js");
  const { Reader } = await import("../src/columnar/storage.js");
  const { ColumnarR2 } = await import("../src/columnar/r2.js");
  const { exhaustive } = await import("../bench/columnar/exhaustive.js");
  const f = fixture(),
    generation = "a".repeat(64),
    sourceRoot = {
      format: "R2-source-v1",
      documents: 257,
      parts: [
        {
          part: 0,
          generation,
          first: 0,
          count: 257,
          inputSha256: "b".repeat(64),
        },
      ],
    };
  const texts = [
    "alpha beta alpha",
    "alpha gap beta",
    "running runs 法院 ﬃ İ 𐐀",
    "beta gamma",
    "",
    "the absence of proof",
    "in the absence of proof",
  ];
  const docs = Array.from({ length: 257 }, (_, i) => ({
    doc: i,
    id: "case-" + i,
    body: texts[i % texts.length],
    title: i % 3 ? "Court beta" : "",
    metadata: { court: "test", ordinal: i },
  }));
  const pointers: number[] = [];
  for (const doc of docs) {
    const body = gzipSync(doc.body),
      info = new TextEncoder().encode(
        JSON.stringify({
          id: doc.id,
          title: doc.title,
          metadata: doc.metadata,
        }),
      );
    for (const [name, bytes] of [
      [`content-${doc.doc}.bin`, body],
      [`info-${doc.doc}.bin`, info],
    ] as const)
      await f.bucket.put(generation + "/" + name, bytes, {
        customMetadata: { generation },
      });
    pointers.push(
      doc.doc,
      0,
      body.length,
      crc32(body),
      doc.doc,
      0,
      info.length,
      crc32(info),
    );
  }
  const { u32 } = await import("../src/columnar/format.js");
  await f.bucket.put(generation + "/contentmap-0.bin", u32(pointers), {
    customMetadata: { generation },
  });
  let worker = createFreshConstructionWorker(sourceRoot as any, "test-code"),
    serial = 0;
  const call = async (path: string, input: any = {}, status = 200) => {
    const response = await worker.fetch(
      new Request("https://test" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          build: "fixture",
          task: "job-" + serial++,
          ...input,
        }),
      }),
      { INDEX: f.bucket, INTERNAL_TOKEN: "test" },
    );
    const data = (await response.json()) as any;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  const originalPut = f.bucket.put.bind(f.bucket);
  let failOnce = true;
  (f.bucket as any).put = async (...args: any[]) => {
    if (failOnce && String(args[0]).includes("/stage-")) {
      failOnce = false;
      throw Error("Injected R2 write failure");
    }
    return (originalPut as any)(...args);
  };
  const failed = await call(
    "/ingest",
    { task: "failed-ingest", first: 0, count: 128 },
    500,
  );
  expect(failed.telemetry.io.failures.put).toBe(1);
  (f.bucket as any).put = originalPut;
  worker = createFreshConstructionWorker(sourceRoot as any, "test-code");
  const recovered = await call("/ingest", {
    task: "failed-ingest",
    first: 0,
    count: 128,
  });
  const duplicate = await call("/ingest", {
    task: "failed-ingest",
    first: 0,
    count: 128,
  });
  expect(duplicate.reused).toBe(true);
  expect(duplicate.output).toEqual(recovered.output);
  expect(duplicate.telemetry.io.operations).toEqual({ get: 1 });
  const ingests = [];
  for (const first of [0, 128, 256])
    ingests.push(
      (await call("/ingest", { first, count: Math.min(128, 257 - first) }))
        .output,
    );
  expect(ingests[0].chunks).toEqual(recovered.output.chunks);
  expect(ingests[0].summaries).toEqual(recovered.output.summaries);
  const summaries = (
    await call("/summaries", {
      runs: ingests.map((r) => ({
        version: 3,
        first: r.first,
        end: r.next,
        chunks: r.summaries,
      })),
    })
  ).output;
  const summary: SummaryRun = {
    version: 3,
    first: 0,
    end: 257,
    chunks: summaries.chunks,
  };
  const hotDf = Math.max(...summaries.histogram.map((p: number[]) => p[0]));
  const cp = (
    await call("/catalogue", {
      run: summary,
      firstId: 1,
      selections: { hot: { df: hotDf, ties: 1 }, pair: { df: 0, ties: 0 } },
    })
  ).output;
  const commonBundle = (await call("/pack-common", { common: cp.common }))
    .output;
  const catalogue: Catalogue = {
    format: "construction-catalogue-v3",
    source: await digest(
      jsonBytes({ sourceRoot, count: 257, analysis: ENGLISH_ANALYSIS }),
    ),
    analysis: ENGLISH_ANALYSIS,
    documents: 257,
    bodyTokens: ingests.reduce((n, r) => n + r.bodyTokens, 0),
    titleTokens: ingests.reduce((n, r) => n + r.titleTokens, 0),
    terms: cp.count,
    partitions: [{ firstId: 1, count: cp.count, summaries: summary }],
    words: cp.packets,
    commonBundle,
    hot: { count: 1, df: hotDf, lastId: cp.lastHotTie },
    pairTerms: cp.pairTerms.sort(
      (a: any, b: any) => b.df - a.df || a.id - b.id,
    ),
  };
  const catalogueRef = await f.store.put(jsonBytes(catalogue));
  await call("/activate", { catalogueRef });
  worker = createFreshConstructionWorker(sourceRoot as any, "test-code");
  const final = (
    await call("/final", {
      catalogueRef,
      runs: ingests,
      partition: 0,
      objectBase: 0,
    })
  ).output;
  expect(final.state.finish.done).toBe(true);
  expect(final.terms).toBe(cp.count);
  const packaged = (
    await call("/packages", {
      task: "package-retry",
      catalogueRef,
      metadataSchema: { court: "string", ordinal: "number" },
      generation: "c".repeat(64),
      first: 0,
      count: 257,
    })
  ).output;
  expect(packaged.end).toBe(257);
  worker = createFreshConstructionWorker(sourceRoot as any, "test-code");
  const retry = await call("/packages", {
    task: "package-retry",
    catalogueRef,
    metadataSchema: { court: "string", ordinal: "number" },
    generation: "c".repeat(64),
    first: 0,
    count: 257,
  });
  expect(retry.reused).toBe(true);
  expect(retry.telemetry.io.operations).toEqual({ get: 1 });
  expect(retry.output).toEqual(packaged);
  await call(
    "/packages",
    {
      task: "package-retry",
      catalogueRef,
      generation: "c".repeat(64),
      first: 1,
      count: 256,
    },
    500,
  );
  const group = packaged.group,
    documentBytes = encodeDocumentDirectory(
      [
        {
          ...group,
          offsets: Uint8Array.from(atob(group.offsets), (c) => c.charCodeAt(0)),
          prefixes: Uint8Array.from(atob(group.prefixes), (c) =>
            c.charCodeAt(0),
          ),
          verificationBytes: Uint8Array.from(
            atob(group.verificationBytes),
            (c) => c.charCodeAt(0),
          ),
        },
      ],
      257,
    );
  const { buildCompletePairs } =
    await import("../scripts/construction-complete-pairs.js");
  let pairAllocation = 16384;
  const completePairs = await buildCompletePairs(
    catalogue,
    catalogueRef,
    [packaged],
    async (path, task, body) => {
      const objectBase =
        path === "/finish-complete-pairs" ? pairAllocation : undefined;
      if (objectBase !== undefined) pairAllocation += 16384;
      return (
        await call(path, {
          ...body,
          task,
          ...(objectBase === undefined ? {} : { objectBase }),
        })
      ).output;
    },
    async (_task, value) => f.store.put(jsonBytes(value)),
    async (rows, fn) => {
      const results = [];
      for (const [i, row] of rows.entries()) results.push(await fn(row, i));
      return results;
    },
    4,
  );
  const directoryBytes = assembleTieredDirectory(
    assembleTermDirectory(
      await Promise.all(
        final.hot.map(async (block: any) => ({
          first: block.first,
          count: block.count,
          data: await f.store.get(block.ref),
        })),
      ),
    ),
    assembleTermDirectory(
      final.cold.map((c: any) => ({
        first: c.first,
        count: c.count,
        data: u32(c.ref),
      })),
    ),
  );
  const metadataOutput = (
    await call("/metadata", {
      first: 0,
      count: 257,
      schema: { court: "string", ordinal: "number" },
      parts: [{ first: 0, end: 257, metadataRef: packaged.metadataRef }],
    })
  ).output;
  const root: any = {
    format: "CWS1",
    analysis: ENGLISH_ANALYSIS,
    generation: "",
    corpusHash: catalogue.source,
    count: 257,
    avgBody: catalogue.bodyTokens / 257,
    avgTitle: catalogue.titleTokens / 257,
    documents: [],
    dictionaries: [],
    hot: {},
    pairMembership: {
      generation: completePairs.metadata.generation,
      ...completePairs.coverage,
    },
    metadataFields: { court: "string", ordinal: "number" },
    objects: final.objects,
    directory: {
      sha256: await digest(directoryBytes),
      bytes: directoryBytes.length,
      terms: cp.count,
    },
    documentPackages: {
      generation: "c".repeat(64),
      count: 257,
      bytes: packaged.verificationBytes,
      storedBytes: packaged.bytes,
      averageBytes: packaged.verificationBytes / 257,
      locators: {
        sha256: await digest(documentBytes),
        bytes: documentBytes.length,
        groups: 1,
      },
    },
  };
  root.generation = await generationFor(root);
  const metadataIdentity = {
    format: "CWM1",
    baseGeneration: root.generation,
    count: 257,
    blockDocuments: 4096,
    schema: root.metadataFields,
    blocks: [metadataOutput.block],
  };
  const metadataManifest = {
    generation: await digest(jsonBytes(metadataIdentity)),
    ...metadataIdentity,
  };
  const directoryRef = await f.store.put(directoryBytes),
    documentsRef = await f.store.put(documentBytes),
    groupKey = group.sha256 + "/plan-0.bin",
    verifiedObjects = [
      ...root.objects,
      {
        key: groupKey,
        sha256: group.sha256,
        size: f.objects.get(groupKey)!.raw.length,
      },
      directoryRef,
      documentsRef,
      ...completePairs.objects,
      ...metadataOutput.objects,
    ];
  await call("/verify", { task: "verify-outputs", objects: verifiedObjects });
  const publication = {
    root,
    catalogueRef,
    metadataManifest,
    pairCoverage: completePairs.coverage,
    expectedPairOccurrences: packaged.completePairs.reduce(
      (n: number, r: any) => n + r.occurrences,
      0,
    ),
    pairObjects: completePairs.objects,
    presence: completePairs.presence,
    terms: catalogue.terms,
    groups: [group],
    objects: verifiedObjects,
    verifications: [{ task: "verify-outputs" }],
    directoryRef,
    documentsRef,
  };
  for (const changed of [
    { ...publication, metadataManifest: undefined },
    { ...publication, metadataManifest: { ...metadataManifest, blocks: [] } },
    { ...publication, pairCoverage: undefined },
    {
      ...publication,
      pairCoverage: { ...publication.pairCoverage, completeContext: false },
    },
    {
      ...publication,
      expectedPairOccurrences: publication.expectedPairOccurrences + 1,
    },
    { ...publication, presence: { ...publication.presence, entries: [] } },
    { ...publication, groups: [{ ...group, first: 1 }] },
    { ...publication, terms: catalogue.terms - 1 },
    { ...publication, verifications: [{ task: "missing-receipt" }] },
    { ...publication, root: { ...root, generation: "0".repeat(64) } },
  ])
    await call(
      "/publish",
      { manifestRef: await f.store.put(jsonBytes(changed)) },
      500,
    );
  await call(
    "/verify",
    { objects: [{ key: "missing-object", size: 1, sha256: "0".repeat(64) }] },
    500,
  );
  await call("/publish", {
    manifestRef: await f.store.put(jsonBytes(publication)),
  });
  expect(f.objects.has(root.generation + "/root.json")).toBe(true);
  const index = new ColumnarIndex(
    root,
    undefined,
    new TermDirectory(directoryBytes, 257),
    undefined,
    new DocumentDirectory(documentBytes),
  );
  const { parse, queryTerms } = await import("../src/query/parser.js"),
    { tokenizerFor } = await import("../src/query/analysis.js"),
    tokenize = tokenizerFor(ENGLISH_ANALYSIS);
  const analyzed = docs.map((d) => ({
    id: d.id,
    fields: [tokenize(d.body), tokenize(d.title)],
  }));
  for (const q of [
    "alpha OR gamma",
    "alpha AND NOT gamma",
    '"alpha beta"',
    '"in the absence of"',
    "alpha /3 beta",
    "running",
    "beta",
    "法院 OR İ",
  ]) {
    const actual = await index.search(
      q,
      new Reader(root, new ColumnarR2(f.bucket)),
      { limit: 20, exactTotal: true },
    );
    const ast = parse(q, "and", tokenize),
      terms = queryTerms(ast, true),
      df = terms.map(
        (w) =>
          analyzed.filter((d) => d.fields.some((f) => f.includes(w))).length,
      );
    const score = (f: string[], w: string, df: number, avg: number) => {
      const tf = f.filter((t) => t === w).length;
      return tf
        ? (Math.log(258 / (df + 0.5)) * tf * 2.2) /
            (tf + 1.2 * (0.25 + (0.75 * f.length) / (avg || 1)))
        : 0;
    };
    const reference = analyzed
      .map((d, doc) => ({
        ...d,
        doc,
        match: exhaustive(ast, d.fields),
        score: terms.reduce(
          (n, w, i) =>
            n +
            score(d.fields[0], w, df[i], root.avgBody) +
            2 * score(d.fields[1], w, df[i], root.avgTitle),
          0,
        ),
      }))
      .filter((d) => d.match)
      .sort((a, b) => b.score - a.score || a.doc - b.doc);
    expect(actual.total, q).toBe(reference.length);
    expect(
      actual.results.map((r: any) => r.id),
      q,
    ).toEqual(reference.slice(0, 20).map((d) => d.id));
  }
});

it("directly reads bounded selection descriptors and preserves full occurrence selection", async () => {
  const { storeSelection, readSelection, occurrenceSelection } =
      await import("../src/columnar/construction/selection-packets.js"),
    f = fixture();
  const selection = {
    documents: 1000,
    terms: Array.from({ length: 40 }, (_, id) => ({ id: id + 1 })),
    pairs: Array.from({ length: 800 }, (_, key) => ({
      key,
      a: Math.floor(key / 40) + 1,
      b: (key % 40) + 1,
      df: 3,
      occurrences: 7,
      cost: 512,
    })),
  };
  const ref = await storeSelection(f.store, selection),
    before = f.calls.get;
  const one = await readSelection(f.store, ref, { firstKey: 270, endKey: 280 });
  expect(one.pairs).toEqual(selection.pairs.slice(270, 280));
  expect(f.calls.get - before).toBe(2);
  expect(await occurrenceSelection(f.store, ref)).toEqual(selection);
  const packet = one.manifest.chunks[1].ref;
  f.objects.get(packet.key)!.raw[packet.offset!] ^= 1;
  await expect(
    readSelection(f.store, ref, { firstKey: 270, endKey: 280 }),
  ).rejects.toThrow("checksum");
});

it("serializes overlapping writes when a shared staging object fills", async () => {
  const { StagingContainer } =
      await import("../src/columnar/construction/staging-container.js"),
    f = fixture(),
    container = new StagingContainer(f.store, 16);
  const original = f.store.putParts.bind(f.store);
  let active = 0,
    peak = 0;
  f.store.putParts = async (parts) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    try {
      return await original(parts);
    } finally {
      active--;
    }
  };
  const raw = Array.from({ length: 20 }, (_, i) => new Uint8Array(9).fill(i)),
    refs = await Promise.all(raw.map((bytes) => container.append(bytes)));
  await container.flush();
  expect(peak).toBe(1);
  for (let i = 0; i < refs.length; i++)
    expect(await f.store.get(refs[i])).toEqual(raw[i]);
});

it("reads and validates directly addressed document sections in the offline adapter", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { OfflineObjects } = await import("../src/columnar/offline.js"),
    dir = await mkdtemp(join(tmpdir(), "cws-offline-")),
    raw = Uint8Array.from({ length: 80 }, (_, i) => i),
    sha256 = await digest(raw),
    key = sha256 + "/plan-0.bin",
    objects = new OfflineObjects(dir, {
      generation: "0".repeat(64),
      objects: [],
    });
  try {
    await mkdir(join(dir, "packages", sha256), { recursive: true });
    await writeFile(join(dir, "packages", key), raw);
    expect([...(await objects.source.readNamed(key + "@17", 9))]).toEqual([
      ...raw.subarray(17, 26),
    ]);
    for (const length of [0, -1, NaN, 0.5, 80])
      await expect(
        objects.source.readNamed(key + "@17", length),
      ).rejects.toThrow("range");
    raw[0] ^= 1;
    await writeFile(join(dir, "packages", key), raw);
    const changed = new OfflineObjects(dir, {
      generation: "0".repeat(64),
      objects: [],
    });
    await expect(changed.source.readNamed(key + "@0", 9)).rejects.toThrow(
      "checksum",
    );
    await changed.close();
  } finally {
    await objects.close();
    await rm(dir, { recursive: true, force: true });
  }
});
