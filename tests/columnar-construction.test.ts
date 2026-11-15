import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { scanText } from "../src/columnar/construction/text.js";
import { tokenOffsets } from "../src/global/build.js";
import {
  CorpusSource,
  type SourceRoot,
} from "../src/columnar/construction/source.js";
import {
  BuildStore,
  ingest,
  merge,
  RunReader,
  RunWriter,
  type Run,
} from "../src/columnar/construction/runs.js";
import {
  finishPostings,
  OBJECT_GROUP,
  routingOf,
  combineRouting,
  type TermRange,
  type FinishState,
} from "../src/columnar/construction/finish.js";
import {
  finishDocuments,
  type DocumentState,
} from "../src/columnar/construction/documents.js";
import { crc32 } from "../src/format/codec.js";
import { type Root, u32, type Ref } from "../src/columnar/format.js";
import { ColumnarIndex } from "../src/columnar/search.js";
import { ColumnarR2 } from "../src/columnar/r2.js";
import { Reader } from "../src/columnar/storage.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { tokenize, type Document } from "../src/query/tokenize.js";
import { ENGLISH_ANALYSIS, tokenizerFor } from "../src/query/analysis.js";
import { finishPackageDocuments } from "../src/columnar/construction/package-documents.js";
import { finishDocumentGroup } from "../src/columnar/construction/document-groups.js";
import { createConstructionWorker } from "../src/columnar/construction/worker.js";
import { concat } from "../src/columnar/format.js";
import { finishTieredTerms } from "../src/columnar/construction/tiered-terms.js";
import {
  TermDirectory,
  assembleTermDirectory,
  assembleTieredDirectory,
} from "../src/columnar/term-directory.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
import { planMerges } from "../scripts/construction-merge-plan.js";
import { projectVocabularyRoot } from "../scripts/construction-vocabulary-root.js";
import { packetRootProjector } from "../scripts/construction-packet-root.js";
import { finishPacketTerms } from "../src/columnar/construction/packet-terms.js";
import {
  encodeWords,
  assembleWords,
  WordDirectory,
} from "../src/columnar/word-directory.js";
import {
  buildVocabulary,
  readVocabulary,
  type Vocabulary,
} from "../src/columnar/construction/vocabulary.js";
function rankedReference(
  docs: Document[],
  terms: string[],
  field: "all" | "body" | "title",
) {
  const rows = docs.map((d) => ({
      id: d.id,
      b: tokenize(d.body),
      t: tokenize(d.title ?? ""),
    })),
    avgB = rows.reduce((n, r) => n + r.b.length, 0) / docs.length,
    avgT = rows.reduce((n, r) => n + r.t.length, 0) / docs.length;
  const df = terms.map(
    (word) =>
      rows.filter((r) => r.b.includes(word) || r.t.includes(word)).length,
  );
  const score = (tokens: string[], word: string, df: number, avg: number) => {
    const tf = tokens.filter((t) => t === word).length;
    return tf
      ? (Math.log((docs.length + 1) / (df + 0.5)) * tf * 2.2) /
          (tf + 1.2 * (0.25 + (0.75 * tokens.length) / (avg || 1)))
      : 0;
  };
  return rows
    .map((r, doc) => ({
      id: r.id,
      doc,
      score: terms.reduce(
        (n, w, j) =>
          n +
          (field === "title" ? 0 : score(r.b, w, df[j], avgB)) +
          (field === "body" ? 0 : 2 * score(r.t, w, df[j], avgT)),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.doc - b.doc);
}

export async function fixture(docs: Document[]) {
  const objects = new Map<
      string,
      { bytes: Uint8Array; customMetadata: Record<string, string> }
    >(),
    generation = "a".repeat(64),
    pointers: number[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i],
      body = gzipSync(d.body),
      info = new TextEncoder().encode(
        JSON.stringify({ id: d.id, title: d.title, metadata: d.metadata }),
      );
    objects.set(`${generation}/content-${i}.bin`, {
      bytes: body,
      customMetadata: { generation },
    });
    objects.set(`${generation}/info-${i}.bin`, {
      bytes: info,
      customMetadata: { generation },
    });
    pointers.push(
      i,
      0,
      body.length,
      crc32(body),
      i,
      0,
      info.length,
      crc32(info),
    );
  }
  objects.set(`${generation}/contentmap-0.bin`, {
    bytes: u32(pointers),
    customMetadata: { generation },
  });
  const bucket = {
    async head(key: string) {
      const o = objects.get(key);
      return o
        ? { size: o.bytes.length, customMetadata: o.customMetadata }
        : null;
    },
    async get(key: string, options?: any) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = options?.range
        ? o.bytes.slice(
            options.range.offset,
            options.range.offset + options.range.length,
          )
        : o.bytes;
      return {
        ...o,
        size: o.bytes.length,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      };
    },
    async put(key: string, value: Uint8Array, options?: any) {
      objects.set(key, {
        bytes: Uint8Array.from(value),
        customMetadata: options?.customMetadata ?? {},
      });
      return { key, size: value.length };
    },
  } as unknown as R2Bucket;
  const sourceRoot: SourceRoot = {
    format: "R2-source-v1",
    documents: docs.length,
    parts: [
      {
        part: 0,
        generation,
        first: 0,
        count: docs.length,
        inputSha256: "b".repeat(64),
      },
    ],
  };
  return {
    source: new CorpusSource(bucket, sourceRoot),
    store: new BuildStore(bucket),
    objects,
    bucket,
    sourceRoot,
  };
}
it("packs many logical sorted-run blocks into one PUT and range-reads each block independently", async () => {
  const f = await fixture([{ id: "a", body: "alpha" }]),
    writer = new RunWriter(f.store, 512);
  for (let doc = 0; doc < 2000; doc++) {
    await writer.append(new Uint8Array(new Uint32Array([12, 1, doc]).buffer));
  }
  await writer.finish();
  expect(writer.chunks.length).toBeGreaterThan(32);
  expect(new Set(writer.chunks.map((c) => c.key)).size).toBe(1);
  expect(f.store.requests).toBe(1);
  const result = concat(
    await Promise.all(writer.chunks.map((c) => f.store.get(c))),
  );
  expect(result.length).toBe(24000);
  for (let i = 0; i < 2000; i++)
    expect(new DataView(result.buffer).getUint32(i * 12 + 8, true)).toBe(i);
  await expect(
    f.store.get({ ...writer.chunks[0], sha256: "0".repeat(64) }),
  ).rejects.toThrow("checksum");
});
it("filters source ordinals without copying archive content or fetching text during metadata selection", async () => {
  const f = await fixture([
      { id: "a", body: "alpha", metadata: { cluster_id: 10 } },
      { id: "b", body: "beta", metadata: { cluster_id: 20 } },
      { id: "c", body: "gamma", metadata: { cluster_id: 30 } },
    ]),
    seen: string[] = [],
    get = f.bucket.get.bind(f.bucket);
  f.bucket.get = ((key: string, options?: any) => {
    seen.push(key);
    return get(key, options);
  }) as any;
  const meta = await f.source.metadata(0, 3);
  expect(meta.rows.map((r) => r.cluster_id)).toEqual([10, 20, 30]);
  expect(seen.some((k) => /\/content-/.test(k))).toBe(false);
  const p = await f.source.pointers(0, 3),
    raw = new Uint8Array(p.view.buffer, p.view.byteOffset, p.view.byteLength),
    map = await f.store.put(
      concat([raw.subarray(0, 32), raw.subarray(64, 96)]),
      "plan-0.bin",
    ),
    source = new CorpusSource(f.bucket, {
      ...f.sourceRoot,
      documents: 2,
      parts: [{ ...f.sourceRoot.parts[0], count: 2, pointerMap: map }],
    });
  expect((await source.document(1)).id).toBe("c");
  expect((await source.document(1)).body).toBe("gamma");
  expect((await source.metadata(0, 2)).rows.map((r) => r.cluster_id)).toEqual([
    10, 30,
  ]);
});
it("exposes metadata-only selection and writes one immutable filtered pointer map through the constructor", async () => {
  const f = await fixture([
      { id: "a", body: "alpha", metadata: { cluster_id: 10 } },
      { id: "b", body: "beta", metadata: { cluster_id: 20 } },
    ]),
    worker = createConstructionWorker(f.sourceRoot, "test"),
    call = async (path: string, body: unknown) =>
      worker.fetch(
        new Request("https://local" + path, {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        { INDEX: f.bucket, INTERNAL_TOKEN: "token" },
      );
  const meta = (await (
    await call("/source-metadata", { first: 0, count: 2 })
  ).json()) as any;
  expect(meta.rows).toEqual([
    { id: "a", cluster_id: 10 },
    { id: "b", cluster_id: 20 },
  ]);
  expect(meta.telemetry.r2.put ?? 0).toBe(0);
  const map = (await (
    await call("/source-filter-map", { part: 0, selected: [1] })
  ).json()) as any;
  expect(map.size).toBe(32);
  expect(map.telemetry.r2.put).toBe(1);
  const source = new CorpusSource(f.bucket, {
    ...f.sourceRoot,
    documents: 1,
    parts: [{ ...f.sourceRoot.parts[0], count: 1, pointerMap: map }],
  });
  expect((await source.document(0)).id).toBe("b");
  expect(
    (await call("/source-filter-map", { part: 0, selected: [1, 1] })).ok,
  ).toBe(false);
});
it("constructs larger byte-bounded document groups and preserves a refused document for continuation", async () => {
  const docs = Array.from({ length: 600 }, (_, i) => ({
      id: String(i),
      body: "alpha beta",
    })),
    f = await fixture(docs),
    root = {
      generation: "a".repeat(64),
      count: docs.length,
      objects: [],
      idRouting: { dictionaries: [] },
    },
    vocabulary = {
      generation: root.generation,
      first: 0,
      end: docs.length,
      ids: new Map([
        ["alpha", 1],
        ["beta", 2],
      ]),
    },
    group = await finishDocumentGroup(
      f.source,
      f.store,
      root,
      vocabulary,
      root.generation,
      0,
      docs.length,
    );
  expect(group.documents).toBe(600);
  expect(f.store.requests).toBe(1);
  const stopped = await finishPackageDocuments(
    f.source,
    f.store,
    root,
    vocabulary,
    root.generation,
    0,
    3,
    async (doc) => doc === 0,
  );
  expect(stopped.end).toBe(1);
  expect(stopped.documents).toBe(1);
});
it("merges stem variants before DF/BM25 construction and finishes stemmed phrases, fields, cursors and original snippets", async () => {
  const docs = [
      {
        id: "a",
        body: "Running runs runner. The runners ran.",
        title: "Running courts",
      },
      { id: "b", body: "run run run courts", title: "Court" },
      { id: "c", body: "runner runs", title: "Runners" },
      { id: "d", body: "unrelated", title: "Courts" },
    ],
    // Explicit expected analysis, independent of the production stemmer.
    reference = [
      { id: "a", body: "run run runner the runner ran", title: "run court" },
      { id: "b", body: "run run run court", title: "court" },
      { id: "c", body: "runner run", title: "runner" },
      { id: "d", body: "unrel", title: "court" },
    ],
    f = await fixture(docs),
    run = await ingest(
      f.source,
      f.store,
      0,
      docs.length,
      262144,
      ENGLISH_ANALYSIS,
    ),
    root: Root = {
      format: "CWS1",
      analysis: ENGLISH_ANALYSIS,
      generation: "c".repeat(64),
      corpusHash: "b".repeat(64),
      count: docs.length,
      avgBody: run.bodyTokens / docs.length,
      avgTitle: run.titleTokens / docs.length,
      documents: [[0, 0, 0]],
      objects: [],
      dictionaries: [],
      hot: {},
    },
    posted = await finishPostings(f.store, run, root, 0),
    routing = routingOf(posted.state);
  expect(posted.state.done).toBe(true);
  root.objects = posted.objects;
  root.hot = Object.fromEntries(routing.hot);
  root.dictionaries = routing.dictionaries;
  root.dictionaryHeight = routing.dictionaryHeight;
  const idsRoot = await projectVocabularyRoot(
    root,
    routing.idRouting,
    new Reader(root, new ColumnarR2(f.bucket)),
  );
  expect(idsRoot.analysis).toBe(ENGLISH_ANALYSIS);
  const vocabularyResult = await buildVocabulary(
      f.source,
      f.store,
      idsRoot,
      0,
      docs.length,
    ),
    vocabulary = await readVocabulary(f.store, vocabularyResult.vocabulary),
    generation = "d".repeat(64),
    packaged = await finishPackageDocuments(
      f.source,
      f.store,
      idsRoot,
      vocabulary,
      generation,
      0,
      docs.length,
    ),
    packets = await finishPacketTerms(
      f.store,
      root,
      root.dictionaries,
      OBJECT_GROUP,
    );
  expect(packets.state.done).toBe(true);
  root.objectIds = root.objects.map((_, i) => i);
  packets.objects.forEach((o, i) => {
    root.objects.push(o);
    root.objectIds!.push(OBJECT_GROUP + i);
  });
  const directory = new TermDirectory(
    assembleTermDirectory(
      await Promise.all(
        packets.blocks.map(async (b) => ({
          first: b.first,
          count: b.count,
          data: await f.store.get(b.ref),
        })),
      ),
    ),
    docs.length,
  );
  const terms = await directory.lookup([
    "run",
    "running",
    "runs",
    "runner",
    "court",
  ]);
  expect(terms.has("running") || terms.has("runs")).toBe(false);
  expect(terms.get("run")!.df).toBe(3);
  expect(terms.get("run")!.bodyOccurrences).toBe(6);
  expect(terms.get("run")!.titleOccurrences).toBe(1);
  expect(terms.get("court")!.df).toBe(3);
  root.documentPackages = {
    generation,
    count: docs.length,
    bytes: packaged.bytes,
    averageBytes: packaged.bytes / docs.length,
  };
  root.documents = [];
  const cold = await finishTieredTerms(
    f.store,
    root,
    packets.blocks.map((b) => b.ref),
    { count: 1, df: 3, lastId: terms.get("court")!.id },
    2 * OBJECT_GROUP,
  );
  expect(cold.hotTerms).toBe(1);
  expect(cold.inlineTerms).toBeGreaterThan(2);
  cold.objects.forEach((o, i) => {
    root.objects.push(o);
    root.objectIds!.push(2 * OBJECT_GROUP + i);
  });
  const tiered = new TermDirectory(
    assembleTieredDirectory(
      assembleTermDirectory(
        cold.hot
          ? [
              {
                first: cold.hot.first,
                count: cold.hot.count,
                data: await f.store.get(cold.hot.ref),
              },
            ]
          : [],
      ),
      assembleTermDirectory(
        cold.cold.map((c) => ({
          first: c.first,
          count: c.count,
          data: u32(c.ref),
        })),
      ),
    ),
    docs.length,
  );
  expect(tiered.terms).toBe(directory.terms);
  const index = new ColumnarIndex(root, undefined, tiered),
    reader = () => new Reader(root, new ColumnarR2(f.bucket)),
    cases = [
      ["running", "all", ["a", "b", "c"]],
      ['"running runs"', "all", ["a", "b"]],
      ['"runner runs"', "all", ["c"]],
      ['"the runners"', "all", ["a"]],
      ["running % courts", "all", ["c"]],
      ["running /1 runs", "body", ["a", "b"]],
      ["running", "title", ["a"]],
      ["courts", "body", ["b"]],
    ] as const;
  for (const [q, field, matches] of cases) {
    const ast = parse(q, "and", tokenizerFor(ENGLISH_ANALYSIS)),
      wanted = new Set(matches),
      scores = rankedReference(reference, queryTerms(ast, true), field).filter(
        (r) => wanted.has(r.id as any),
      ),
      actual = await index.search(q, reader(), { limit: 20, field });
    expect(
      actual.results.map((r) => r.id),
      q,
    ).toEqual(scores.map((r) => r.id));
    actual.results.forEach((r, i) =>
      expect(r.score, q).toBeCloseTo(scores[i].score, 13),
    );
  }
  const first = await index.search("running", reader(), { limit: 1 });
  const firstDoc = docs.findIndex((d) => d.id === first.results[0].id);
  const rest = await index.search("runs", reader(), {
    after: { doc: firstDoc, score: first.results[0].score },
  });
  expect(rest.results).toHaveLength(2);
  const original = await index.search('"running runs"', reader());
  expect(original.results.find((r) => r.id === "a")!.snippet).toContain(
    "Running runs",
  );
});
it("scans exact Unicode display offsets without allocating character maps", () => {
  const samples = [
    "",
    "İstanbul ΣΟΣ Σ A😀ﬁ １２３",
    "𝔘nicode\ud800word\udfff ẞ 👩‍🔬",
    "A".repeat(400) + "İ z",
    Array.from({ length: 15000 }, (_, i) =>
      String.fromCodePoint((i * 977) % 0x110000),
    ).join(" "),
  ];
  for (const original of samples) {
    const old = tokenOffsets(original),
      scan = scanText(original),
      tokens = [...scan.tokens()];
    expect(scan.text).toBe(old.text);
    expect(tokens.map((t) => t.word)).toEqual(old.terms);
    expect(tokens.map((t) => t.start)).toEqual(old.starts);
    expect(tokens.map((t) => t.end)).toEqual(old.ends);
  }
});
it("builds the serving format through bounded R2 runs, resumed merges, and finalization; preserves ranking, negatives, snippets and pagination", async () => {
  const docs = Array.from({ length: 600 }, (_, i) => ({
    id: `d${i}`,
    title: i % 3 ? "Court Alpha" : "Gamma",
    body: i % 11 ? "alpha beta common common" : "rare alpha x beta common",
    metadata: { i },
  }));
  docs[7].body = "alpha " + "common ".repeat(1100) + "beta alpha gamma";
  docs[8].body = "Ａlpha İ gamma beta";
  const { source, store, bucket } = await fixture(docs),
    runs: Run[] = [];
  for (let first = 0; first < docs.length;) {
    const run = await ingest(source, store, first, 43, 150);
    runs.push(run);
    first = run.next;
  }
  // Small physical chunks give the corpus-selected lexical planner useful
  // fences. The first lexical split has several document groups, exercising
  // both dimensions of the merge grid before global frequencies are final.
  for (const run of runs) {
    const reader = new RunReader(store, run.chunks),
      writer = new RunWriter(store, 512);
    for (;;) {
      const record = await reader.peek();
      if (!record) break;
      await writer.append(record);
      reader.consume(record);
    }
    await writer.flush();
    run.chunks = writer.chunks;
  }
  const mergeGroup = async (
    group: Run[],
    range?: { firstWord?: string; endWord?: string },
  ): Promise<Run> => {
    if (group.length === 1 && !range) return group[0];
    const chunks = [];
    let state;
    do {
      const out = await merge(store, group, state, 777, range);
      state = out.state;
      chunks.push(...out.chunks);
    } while (!state.done);
    return {
      first: group[0].first,
      next: group.at(-1)!.next,
      count: group.reduce((n, r) => n + r.count, 0),
      bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
      titleTokens: group.reduce((n, r) => n + r.titleTokens, 0),
      chunks,
    };
  };
  let gridExercised = false;
  // Multiple external merge levels and deliberate continuations inside terms.
  while (runs.length > 1) {
    const plan = planMerges(runs, 32),
      parts = await Promise.all(
        plan.jobs.map((j) =>
          mergeGroup(runs.slice(j.firstRun, j.endRun), j.range),
        ),
      );
    let next = parts;
    if (plan.lexical) {
      const columns: Run[][] = [];
      plan.jobs.forEach((job, i) =>
        (columns[job.lexical!] ??= []).push(parts[i]),
      );
      gridExercised ||= columns.length > 1 && columns.some((c) => c.length > 1);
      const final = await Promise.all(columns.map((c) => mergeGroup(c)));
      next = [
        {
          first: runs[0].first,
          next: runs.at(-1)!.next,
          count: runs.reduce((n, r) => n + r.count, 0),
          bodyTokens: runs.reduce((n, r) => n + r.bodyTokens, 0),
          titleTokens: runs.reduce((n, r) => n + r.titleTokens, 0),
          chunks: final.flatMap((r) => r.chunks),
        },
      ];
    }
    runs.splice(0, runs.length, ...next);
  }
  expect(gridExercised).toBe(true);
  const run = runs[0],
    root: Root = {
      format: "CWS1",
      generation: "c".repeat(64),
      corpusHash: "b".repeat(64),
      count: docs.length,
      avgBody: run.bodyTokens / docs.length,
      avgTitle: run.titleTokens / docs.length,
      documents: Array.from(
        { length: Math.ceil(docs.length / 4096) },
        () => [0, 0, 0] as Ref,
      ),
      objects: [],
      hot: {},
      dictionaries: [],
    };
  const original = new RunReader(store, run.chunks),
    writer = new RunWriter(store, 512);
  for (;;) {
    const record = await original.peek();
    if (!record) break;
    await writer.append(record);
    original.consume(record);
  }
  await writer.flush();
  run.chunks = writer.chunks;
  const starts: Omit<TermRange, "end">[] = [];
  let nextTerm = 1;
  for (let chunk = 0; chunk < run.chunks.length; chunk++) {
    const c = run.chunks[chunk];
    if (c.firstTerm)
      starts.push({
        first: { chunk, at: c.firstTerm.at },
        firstTerm: nextTerm,
      });
    nextTerm += c.terms!;
  }
  expect(starts.length).toBeGreaterThan(2);
  expect(starts.some((s) => s.first.at > 0)).toBe(true);
  const parts = await Promise.all(
    starts.map(async (start, i) => {
      const objects: Root["objects"] = [];
      let state: FinishState | undefined;
      do {
        const result = await finishPostings(
          store,
          run,
          root,
          i * OBJECT_GROUP + objects.length,
          state,
          3000,
          { ...start, end: starts[i + 1]?.first },
        );
        objects.push(...result.objects);
        state = result.state;
      } while (!state.done);
      return { objects, routing: routingOf(state) };
    }),
  );
  root.objectIds = [];
  const append = (objects: Root["objects"], base: number) => {
    for (let i = 0; i < objects.length; i++) {
      root.objects.push(objects[i]);
      root.objectIds!.push(base + i);
    }
  };
  parts.forEach((p, i) => append(p.objects, i * OBJECT_GROUP));
  const combined = await combineRouting(
    store,
    parts.map((p) => p.routing),
    parts.length * OBJECT_GROUP,
  );
  append(combined.objects, parts.length * OBJECT_GROUP);
  root.hot = Object.fromEntries(combined.routing.hot);
  root.dictionaries = combined.routing.dictionaries;
  root.dictionaryHeight = combined.routing.dictionaryHeight;
  const leafFences: Root["dictionaries"] = [],
    dictionaryReader = new Reader(root, new ColumnarR2(bucket));
  async function collectLeaves(fences: Root["dictionaries"], height: number) {
    for (const fence of fences)
      if (height)
        await collectLeaves(
          JSON.parse(
            new TextDecoder().decode(await dictionaryReader.read(fence.ref)),
          ),
          height - 1,
        );
      else leafFences.push(fence);
  }
  await collectLeaves(root.dictionaries, root.dictionaryHeight ?? 0);
  const fence = [leafFences[0]],
    packetRoot = packetRootProjector(root)(fence);
  expect(packetRoot.objects.length).toBeLessThan(root.objects.length);
  async function packetOutput(input: Root) {
    const objects: Root["objects"] = [],
      blocks = [];
    let state:
      Awaited<ReturnType<typeof finishPacketTerms>>["state"] | undefined;
    do {
      const result = await finishPacketTerms(
        store,
        input,
        fence,
        20000 * OBJECT_GROUP + objects.length,
        state,
        1000,
      );
      objects.push(...result.objects);
      blocks.push(...result.blocks);
      state = result.state;
    } while (!state.done);
    return { objects, blocks, state };
  }
  expect(await packetOutput(packetRoot)).toEqual(await packetOutput(root));
  const documentBase = (parts.length + 1) * OBJECT_GROUP;
  let documentObjects = 0;
  let documentState: DocumentState | undefined,
    done = false;
  const projected = await projectVocabularyRoot(
    root,
    combined.routing.idRouting,
    new Reader(root, new ColumnarR2(bucket)),
  );
  expect(projected.objects.length).toBeLessThan(root.objects.length);
  const builtVocabulary = await buildVocabulary(
      source,
      store,
      projected,
      0,
      docs.length,
    ),
    vocabulary = await readVocabulary(store, builtVocabulary.vocabulary);
  const allWords: string[] = [],
    idReader = new Reader(projected, new ColumnarR2(bucket));
  async function collectWords(fences: Root["dictionaries"], height: number) {
    for (const fence of fences) {
      const data = JSON.parse(
        new TextDecoder().decode(await idReader.read(fence.ref)),
      );
      if (height) await collectWords(data, height - 1);
      else
        for (const [word, id] of data) {
          expect(id).toBe(allWords.length + 1);
          allWords.push(word);
        }
    }
  }
  await collectWords(
    projected.idRouting.dictionaries,
    projected.idRouting.dictionaryHeight ?? 0,
  );
  const wordDirectory = new WordDirectory(
    assembleWords([
      {
        first: allWords[0],
        count: allWords.length,
        data: encodeWords(allWords),
      },
    ]),
  );
  const bundledVocabulary = await buildVocabulary(
    source,
    store,
    {
      ...projected,
      objects: [],
      objectIds: [],
      idRouting: { dictionaries: [] },
    },
    0,
    docs.length,
    {
      generation: projected.generation,
      lookup: (names) => wordDirectory.lookup(names),
    },
  );
  expect(bundledVocabulary.vocabulary).toEqual(builtVocabulary.vocabulary);
  expect(bundledVocabulary.dictionaryRequests).toBe(0);
  expect(bundledVocabulary.dictionaryBytes).toBe(0);
  do {
    const out = await finishDocuments(
      source,
      store,
      root,
      vocabulary,
      documentBase + documentObjects,
      documentState,
      100,
    );
    documentState = out.state;
    append(out.objects, documentBase + documentObjects);
    documentObjects += out.objects.length;
    done = out.done;
  } while (!done);
  root.documents = documentState!.documents;
  expect(root.objects.every(Boolean)).toBe(true);
  const index = new ColumnarIndex(root),
    reader = () => new Reader(root, new ColumnarR2(bucket));
  for (const q of [
    "alpha",
    "common",
    "rare beta",
    "alpha OR gamma",
    "NOT rare",
    'NOT "alpha beta"',
    'common NOT "alpha beta"',
    '"alpha alpha"',
    '"common common common"',
    "alpha /3 beta",
    "(alpha OR gamma) /3 beta",
    "İ",
  ])
    for (const field of ["all", "body", "title"] as const) {
      const terms = queryTerms(parse(q), true),
        matched = new Set(
          docs
            .filter((d) =>
              exhaustive(
                parse(q),
                field === "all"
                  ? [tokenize(d.body), tokenize(d.title)]
                  : [tokenize(d[field])],
              ),
            )
            .map((d) => d.id),
        );
      const ranked = rankedReference(docs, terms, field),
        want = ranked.filter((r) => matched.has(r.id));
      const got = await index.search(q, reader(), { field, limit: 7 });
      expect(
        got.results.map((r) => r.id),
        q + field,
      ).toEqual(want.slice(0, 7).map((r) => r.id));
      got.results.forEach((r, i) => {
        expect(r.score).toBeCloseTo(want[i].score, 11);
        expect(r.metadata).toEqual(docs[Number(r.id.slice(1))].metadata);
        expect(r.snippet).toBeTruthy();
      });
      if (got.results.length) {
        const last = got.results.at(-1)!,
          next = await index.search(q, reader(), {
            field,
            limit: 7,
            after: { score: last.score, doc: last.doc },
          });
        expect(
          next.results.map((r) => r.id),
          q + field + "after",
        ).toEqual(want.slice(7, 14).map((r) => r.id));
      }
    }
  const phrase = await index.search('"beta alpha gamma"', reader());
  expect(phrase.results.map((r) => r.id)).toEqual(["d7"]);
  expect(phrase.results[0].snippet).toContain("beta alpha gamma");
}, 120000);
it("rejects corrupt source content and overlapping merge ranges", async () => {
  const f = await fixture([
      { id: "one", body: "alpha" },
      { id: "two", body: "beta" },
    ]),
    run = await ingest(f.source, f.store, 0, 1);
  await expect(merge(f.store, [run, run])).rejects.toThrow("consecutive");
  f.objects.get("a".repeat(64) + "/content-1.bin")!.bytes[0] ^= 1;
  await expect(f.source.document(1)).rejects.toThrow("checksum");
});
it("joins independently built document ranges across the 4096-document boundary", async () => {
  const docs = Array.from({ length: 4103 }, (_, i) => ({
      id: `boundary-${i}`,
      body: "alpha beta",
      metadata: { i },
    })),
    { source, store, bucket } = await fixture(docs);
  let runs: Run[] = [];
  for (let first = 0; first < docs.length;) {
    const run = await ingest(
      source,
      store,
      first,
      Math.min(128, docs.length - first),
    );
    runs.push(run);
    first = run.next;
  }
  while (runs.length > 1) {
    const next: Run[] = [];
    for (let at = 0; at < runs.length; at += 16) {
      const group = runs.slice(at, at + 16);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const merged = await merge(store, group, undefined, 32 * 1048576);
      expect(merged.state.done).toBe(true);
      next.push({
        ...group[0],
        next: group.at(-1)!.next,
        count: group.reduce((n, r) => n + r.count, 0),
        bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
        titleTokens: 0,
        chunks: merged.chunks,
      });
    }
    runs = next;
  }
  const root: Root = {
    format: "CWS1",
    generation: "c".repeat(64),
    corpusHash: "b".repeat(64),
    count: docs.length,
    avgBody: 2,
    avgTitle: 0,
    objects: [],
    objectIds: [],
    documents: [
      [0, 0, 0],
      [0, 0, 0],
    ],
    hot: {},
    dictionaries: [],
  };
  const postings = await finishPostings(
    store,
    runs[0],
    root,
    0,
    undefined,
    32 * 1048576,
  );
  expect(postings.state.done).toBe(true);
  const route = routingOf(postings.state);
  Object.assign(root, {
    dictionaries: route.dictionaries,
    dictionaryHeight: route.dictionaryHeight,
    hot: Object.fromEntries(route.hot),
    objects: postings.objects,
    objectIds: postings.objects.map((_, i) => i),
  });
  const parts = await Promise.all(
    [0, 4096].map(async (first, i) => {
      const base = (i + 1) * OBJECT_GROUP,
        objects: Root["objects"] = [];
      let state: DocumentState | undefined,
        vocabulary: Vocabulary | undefined,
        done = false;
      while (!done) {
        const next = state?.next ?? first;
        if (!vocabulary || next >= vocabulary.end) {
          const built = await buildVocabulary(
            source,
            store,
            { ...root, idRouting: route.idRouting },
            next,
            Math.min(1024, first + 4096 - next, docs.length - next),
          );
          vocabulary = await readVocabulary(store, built.vocabulary);
        }
        const result = await finishDocuments(
          source,
          store,
          root,
          vocabulary,
          base + objects.length,
          state,
          512,
          { first, end: Math.min(first + 4096, docs.length) },
        );
        objects.push(...result.objects);
        state = result.state;
        done = result.done;
      }
      return { base, objects, documents: state!.documents };
    }),
  );
  root.documents = parts.flatMap((p) => p.documents);
  for (const part of parts)
    for (let i = 0; i < part.objects.length; i++) {
      root.objects.push(part.objects[i]);
      root.objectIds!.push(part.base + i);
    }
  const index = new ColumnarIndex(root),
    reader = () => new Reader(root, new ColumnarR2(bucket)),
    first = await index.search('"alpha beta"', reader(), { limit: 1 }),
    tail = await index.search('"alpha beta"', reader(), {
      after: { score: first.results[0].score, doc: 4094 },
      limit: 20,
    });
  expect(tail.results.map((r) => r.id)).toEqual(
    docs.slice(4095).map((d) => d.id),
  );
  expect(tail.results.map((r) => r.metadata)).toEqual(
    docs.slice(4095).map((d) => d.metadata),
  );
  expect(tail.results.every((r) => r.snippet?.includes("alpha beta"))).toBe(
    true,
  );
}, 120000);
