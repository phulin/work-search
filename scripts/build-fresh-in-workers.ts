import {
  readFile,
  writeFile,
  mkdir,
  rename,
  appendFile,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { benchmarkToken } from "../bench/columnar/token.js";
import {
  constructionHTTP,
  retryableConstructionError,
} from "./construction-http.js";
import { Semaphore } from "../src/columnar/storage.js";
import {
  type Run,
  type Chunk,
  generationFor,
} from "../src/columnar/construction/runs.js";
import {
  type Catalogue,
  selectionThreshold,
} from "../src/columnar/construction/catalogue.js";
import type { SummaryRun } from "../src/columnar/construction/term-summaries.js";
import { type Root, u32 } from "../src/columnar/format.js";
import {
  assembleTermDirectory,
  assembleTieredDirectory,
} from "../src/columnar/term-directory.js";
import { encodeDocumentDirectory } from "../src/columnar/document-directory.js";
import { ENGLISH_ANALYSIS } from "../src/query/analysis.js";
import {
  buildCompletePairs,
  completePairRouter,
} from "./construction-complete-pairs.js";
import { OBJECT_GROUP } from "../src/columnar/construction/finish.js";

const [countArg, out, build, url, sourcePath] = process.argv.slice(2),
  count = Number(countArg),
  width = Number(process.env.CWS_BUILD_CONCURRENCY ?? 8);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  !out ||
  !build ||
  !/^[a-z0-9-]{1,80}$/.test(build) ||
  !/^https:\/\/work-search-cws-fresh-[a-z0-9-]+\.phulin\.workers\.dev$/.test(
    url ?? "",
  ) ||
  !sourcePath ||
  !Number.isInteger(width) ||
  width < 1 ||
  width > 64
)
  throw Error(
    "Usage: build-fresh-in-workers.ts COUNT OUT BUILD ISOLATED_URL SOURCE_ROOT",
  );
await mkdir(out + "/tasks", { recursive: true });
const token = await benchmarkToken(),
  http = constructionHTTP(width),
  slots = new Semaphore(width),
  sourceRoot = JSON.parse(await readFile(sourcePath, "utf8"));
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const health = (await fetch(url + "/health", {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json())) as any;
if (
  health.format !== "fresh-construction-v3" ||
  count > health.documents ||
  health.source !== hash(sourceRoot)
)
  throw Error("Constructor/source mismatch");
const config = {
  codec: process.env.CWS_RUN_CODEC ?? "delta-gzip-v3",
  blockBytes: Number(process.env.CWS_RUN_BLOCK_BYTES ?? 262144),
  containerBytes: Number(process.env.CWS_RUN_CONTAINER_BYTES ?? 16 * 1048576),
  hotTerms: Number(process.env.CWS_COMMON_TERMS ?? 1000000),
  commonWords: 200,
  metadataSchema: JSON.parse(
    process.env.CWS_METADATA_SCHEMA ??
      '{"opinion_id":"number","cluster_id":"number","date_filed":"string","precedential_status":"string"}',
  ) as Record<string, "string" | "number" | "boolean">,
};
const source = hash({ sourceRoot, count, analysis: ENGLISH_ANALYSIS }),
  identity = {
    format: "fresh-coordinator-v3",
    build,
    url,
    source,
    code: health.code,
    coordinator: hash(await readFile(new URL(import.meta.url), "utf8")),
    analysis: ENGLISH_ANALYSIS,
    count,
    width,
    config,
  };
const manifest = await readFile(out + "/manifest.json", "utf8").then(
  JSON.parse,
  () => undefined,
);
if (manifest && hash(manifest.identity) !== hash(identity))
  throw Error(
    "Fresh build manifest changed; choose a new build/output directory",
  );
if (!manifest)
  await writeFile(
    out + "/manifest.json",
    JSON.stringify(
      {
        identity,
        startedAt: new Date().toISOString(),
        startingCheckpoint: "empty",
        controlArchiveSha256:
          "71a29105af89bbfa058c0666093707e71f40d48ad62230bf61bdd2de60b849c4",
      },
      null,
      2,
    ),
  );
let allocation = 0;
for (const line of (
  await readFile(out + "/allocations.jsonl", "utf8").catch(() => "")
)
  .trim()
  .split("\n"))
  if (line) allocation = Math.max(allocation, JSON.parse(line).group + 1);
async function atomic(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value));
  await rename(path + ".tmp", path);
}
async function record(value: unknown) {
  await appendFile(
    out + "/requests.jsonl",
    JSON.stringify({ at: new Date().toISOString(), ...(value as any) }) + "\n",
  );
}
async function call(path: string, task: string, body: any = {}) {
  const file = out + "/tasks/" + task + ".json",
    existing = await readFile(file, "utf8").then(JSON.parse, () => undefined);
  if (existing) {
    if (existing.path !== path || hash(existing.body) !== hash(body))
      throw Error("Local task input changed: " + task);
    if (existing.output !== undefined) return existing.output;
  }
  const input = existing?.input ?? { ...body, build, task };
  if (!existing) {
    if (["/final", "/finish-complete-pairs"].includes(path)) {
      const group = allocation++;
      if (group >= 262144) throw Error("Object allocation exhausted");
      await appendFile(
        out + "/allocations.jsonl",
        JSON.stringify({ task, group }) + "\n",
      );
      input.objectBase = group * OBJECT_GROUP;
    }
    await atomic(file, { path, body, input });
  }
  return slots.run(async () => {
    for (let attempt = 0; ; attempt++) {
      const start = performance.now();
      let response: any;
      try {
        const r = await http(url + path, token, JSON.stringify(input));
        response = JSON.parse(await r.text());
        await record({
          path,
          task,
          attempt,
          clientMs: performance.now() - start,
          status: r.status,
          ray: r.ray,
          telemetry: response.telemetry,
          reused: response.reused,
          originalWork: response.originalWork,
          error: response.error,
        });
        if (!r.ok) throw Error(response.error ?? "HTTP " + r.status);
        const output = {
          ...response.output,
          ...(input.objectBase === undefined
            ? {}
            : { objectBase: input.objectBase }),
        };
        await atomic(file, { path, body, input, output });
        return output;
      } catch (error) {
        if (!response)
          await record({
            path,
            task,
            attempt,
            clientMs: performance.now() - start,
            error: String(error),
            transportFailure: true,
          });
        if (attempt >= 20 || !retryableConstructionError(response?.error))
          throw error;
        const delay =
          response?.error && response.error !== "Busy"
            ? Math.min(20000, 1000 * 2 ** Math.min(attempt, 5))
            : Math.min(5000, 250 * (attempt + 1));
        await new Promise((r) =>
          setTimeout(r, delay * (0.75 + Math.random() * 0.5)),
        );
      }
    }
  });
}
async function stage(task: string, value: unknown): Promise<Chunk> {
  return call("/stage", task, { value });
}
async function download(ref: Chunk) {
  return slots.run(async () => {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      let r: Response | undefined;
      let raw: Uint8Array;
      try {
        r = await fetch(url + "/download", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ref }),
        });
        raw = new Uint8Array(await r.arrayBuffer());
      } catch (error) {
        await record({
          path: "/download",
          coordinator: true,
          attempt,
          clientMs: performance.now() - started,
          transportFailure: true,
          error: String(error),
        });
        if (attempt >= 20) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(5000, 250 * (attempt + 1))),
        );
        continue;
      }
      await record({
        path: "/download",
        attempt,
        coordinator: true,
        status: r.status,
        clientMs: performance.now() - started,
        ray: r.headers.get("cf-ray")?.split("-")[0],
        downloadedBytes: raw.length,
        telemetry: JSON.parse(
          r.headers.get("x-construction-telemetry") ?? "null",
        ),
      });
      if (!r.ok && [429, 502, 503, 504].includes(r.status) && attempt < 20) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(5000, 250 * (attempt + 1))),
        );
        continue;
      }
      if (
        !r.ok ||
        raw.length !== ref.size ||
        createHash("sha256").update(raw).digest("hex") !== ref.sha256
      )
        throw Error("Coordinator download mismatch");
      return raw;
    }
  });
}
async function upload(raw: Uint8Array) {
  const started = performance.now();
  const r = await fetch(url + "/object", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: raw as BodyInit,
    }),
    result = (await r.json()) as any;
  await record({
    path: "/object",
    coordinator: true,
    status: r.status,
    clientMs: performance.now() - started,
    ray: r.headers.get("cf-ray")?.split("-")[0],
    uploadedBytes: raw.length,
    telemetry: result.telemetry,
  });
  if (!r.ok) throw Error("Coordinator upload failed");
  return result.ref as Chunk;
}
async function pool<T, R>(
  jobs: T[],
  f: (job: T, i: number) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const result: R[] = Array(jobs.length);
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        result[i] = await f(jobs[i], i);
      }
    }),
  );
  return result;
}
async function phase<T>(name: string, f: () => Promise<T>): Promise<T> {
  const file = out + "/" + name + ".json",
    old = await readFile(file, "utf8").then(JSON.parse, () => undefined);
  if (old) return old;
  console.log("Starting", name, new Date().toISOString());
  const result = await f();
  await atomic(file, result);
  console.log("Completed", name, new Date().toISOString());
  return result;
}
const ingests: Run[] = await phase("ingests", async () => {
  const ranges = Array.from({ length: Math.ceil(count / 2048) }, (_, i) => ({
    first: i * 2048,
    end: Math.min(count, (i + 1) * 2048),
  }));
  const batches = await pool(ranges, async ({ first, end }, i) => {
    const runs: Run[] = [];
    for (let next = first; next < end;) {
      const r = await call("/ingest", `ingest-${next}`, {
        ...config,
        first: next,
        count: Math.min(512, end - next),
      });
      if (r.first !== next || r.next <= next || r.next > end)
        throw Error("Ingest coverage mismatch");
      runs.push(r);
      next = r.next;
    }
    console.log("Ingest range", i + 1, "/", ranges.length);
    return runs;
  });
  return batches.flat();
});
let bodyTokens = 0,
  titleTokens = 0,
  nextDocument = 0;
for (const run of ingests) {
  if (run.first !== nextDocument) throw Error("Ingest coverage gap");
  nextDocument = run.next;
  bodyTokens += run.bodyTokens;
  titleTokens += run.titleTokens;
}
if (nextDocument !== count) throw Error("Incomplete ingest");
const catalogueBuild = phase("catalogue", async () => {
  let runs: SummaryRun[] = ingests.map((r) => ({
      version: 3,
      first: r.first,
      end: r.next,
      chunks: r.summaries!,
    })),
    level = 0;
  while (runs.length > 1) {
    const groups = Array.from({ length: Math.ceil(runs.length / 16) }, (_, i) =>
      runs.slice(i * 16, i * 16 + 16),
    );
    runs = await pool(groups, async (group, g) => {
      if (group.length === 1) return group[0];
      const chunks: Chunk[] = [];
      let stateRef: Chunk | undefined,
        done = false,
        step = 0;
      do {
        const r = await call("/summaries", `summary-${level}-${g}-${step++}`, {
          runs: group,
          ...(stateRef ? { stateRef } : {}),
        });
        chunks.push(...r.chunks);
        stateRef = r.stateRef;
        done = r.state.done;
      } while (!done);
      return {
        version: 3,
        first: group[0].first,
        end: group.at(-1)!.end,
        chunks,
      };
    });
    level++;
  }
  const global = runs[0],
    histogram = new Map<number, number>();
  // Summary-only scan. The histogram is produced by reduction responses; the
  // final lexical chunks also bound independently scheduled catalogue jobs.
  const { decodeSummaries } =
      await import("../src/columnar/construction/term-summaries.js"),
    { gunzipSync } = await import("node:zlib");
  const counts: Map<number, number>[] = [];
  for (const chunk of global.chunks) {
    const h = new Map<number, number>();
    for (const row of decodeSummaries(gunzipSync(await download(chunk)))) {
      h.set(row.df, (h.get(row.df) ?? 0) + 1);
      histogram.set(row.df, (histogram.get(row.df) ?? 0) + 1);
    }
    counts.push(h);
  }
  const terms = global.chunks.reduce((n, c) => n + c.terms!, 0),
    hot = selectionThreshold([...histogram], Math.min(config.hotTerms, terms)),
    pair = selectionThreshold(
      [...histogram],
      Math.min(config.commonWords, terms),
    );
  const partitions: Catalogue["partitions"] = [],
    selections: any[] = [];
  let id = 1,
    hotTies = hot.ties,
    pairTies = pair.ties;
  const pieces = Math.min(width, global.chunks.length);
  for (let i = 0; i < pieces; i++) {
    const first = Math.floor((i * global.chunks.length) / pieces),
      end = Math.floor(((i + 1) * global.chunks.length) / pieces),
      chunks = global.chunks.slice(first, end),
      n = chunks.reduce((s, c) => s + c.terms!, 0);
    const h = counts
        .slice(first, end)
        .reduce((n, m) => n + (m.get(hot.df) ?? 0), 0),
      p = counts
        .slice(first, end)
        .reduce((n, m) => n + (m.get(pair.df) ?? 0), 0);
    selections.push({
      hot: { df: hot.df, ties: Math.min(hotTies, h) },
      pair: { df: pair.df, ties: Math.min(pairTies, p) },
    });
    hotTies -= Math.min(hotTies, h);
    pairTies -= Math.min(pairTies, p);
    partitions.push({
      firstId: id,
      count: n,
      summaries: { version: 3, first: 0, end: count, chunks },
    });
    id += n;
  }
  const parts = await pool(partitions, async (part, p) => {
    let stateRef: Chunk | undefined,
      done = false,
      step = 0;
    const outputs: any[] = [];
    do {
      const r = await call("/catalogue", `catalogue-${p}-${step++}`, {
        run: part.summaries,
        firstId: part.firstId,
        selections: selections[p],
        ...(stateRef ? { stateRef } : {}),
      });
      outputs.push(r);
      stateRef = r.stateRef;
      done = r.state.done;
    } while (!done);
    return outputs;
  });
  const outputs = parts.flat(),
    common = outputs.flatMap((o) => o.common),
    commonBundle = await call("/pack-common", "pack-common", { common }),
    pairTerms = outputs
      .flatMap((o) => o.pairTerms)
      .sort((a, b) => b.df - a.df || a.id - b.id);
  const catalogue: Catalogue = {
    format: "construction-catalogue-v3",
    source,
    analysis: ENGLISH_ANALYSIS,
    documents: count,
    bodyTokens,
    titleTokens,
    terms,
    partitions,
    words: outputs.flatMap((o) => o.packets),
    hot: {
      count: Math.min(config.hotTerms, terms),
      df: hot.df,
      lastId: Math.max(0, ...outputs.map((o) => o.lastHotTie)),
    },
    pairTerms,
    commonBundle,
  };
  if (pairTerms.length !== Math.min(config.commonWords, terms))
    throw Error("Pair vocabulary selection coverage mismatch");
  const ref = await stage("catalogue-manifest", catalogue);
  await call("/activate", "activate-catalogue", { catalogueRef: ref });
  return { catalogue, ref };
});
const intermediateBuild = phase("intermediates", async () => {
  let runs = ingests,
    level = 0;
  while (runs.length > 16 * Math.min(width, 16)) {
    const groups = Array.from({ length: Math.ceil(runs.length / 16) }, (_, i) =>
      runs.slice(i * 16, i * 16 + 16),
    );
    runs = await pool(groups, async (group, g) =>
      mergeRun(group, `merge-${level}-${g}`),
    );
    level++;
  }
  return runs;
});
async function mergeRun(
  group: Run[],
  task: string,
  range?: { firstWord?: string; endWord?: string },
): Promise<Run> {
  if (group.length === 1 && !range) return group[0];
  if (group.length === 1) return group[0]; // final reader applies the lexical range
  const runsRef = await stage(task + "-inputs", group),
    chunks: Chunk[] = [];
  let stateRef: Chunk | undefined,
    done = false,
    step = 0;
  do {
    const r = await call("/merge", `${task}-${step++}`, {
      ...config,
      runsRef,
      ...(stateRef ? { stateRef } : {}),
      ...(range ? { range } : {}),
    });
    chunks.push(...r.chunks);
    stateRef = r.stateRef;
    done = r.state.done;
  } while (!done);
  return {
    first: group[0].first,
    next: group.at(-1)!.next,
    count: group.reduce((n, r) => n + r.count, 0),
    bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
    titleTokens: group.reduce((n, r) => n + r.titleTokens, 0),
    chunks,
  };
}
const [{ catalogue, ref: catalogueRef }, intermediates] = await Promise.all([
  catalogueBuild,
  intermediateBuild,
]);
const packageGeneration = hash({
  source,
  catalogue: catalogueRef.sha256,
  format: "CDP4",
  analysis: ENGLISH_ANALYSIS,
});
const finalBuild = phase("postings", async () => {
  const outputs = await pool(catalogue.partitions, async (part, p) => {
    const firstWord = part.summaries.chunks[0].firstWord,
      endWord = catalogue.partitions[p + 1]?.summaries.chunks[0].firstWord;
    let runs = intermediates;
    if (runs.length > 16) {
      const groups = Array.from(
        { length: Math.ceil(runs.length / 16) },
        (_, i) => runs.slice(i * 16, i * 16 + 16),
      );
      runs = await pool(groups, (g, i) =>
        mergeRun(g, `lexical-${p}-${i}`, { firstWord, endWord }),
      );
    }
    const runsRef = await stage(`final-${p}-inputs`, runs),
      outputs: any[] = [];
    let stateRef: Chunk | undefined,
      done = false,
      step = 0;
    do {
      const r = await call("/final", `final-${p}-${step++}`, {
        catalogueRef,
        runsRef,
        partition: p,
        ...(stateRef ? { stateRef } : {}),
      });
      outputs.push(r);
      stateRef = r.stateRef;
      done = r.state.finish.done;
    } while (!done);
    return outputs;
  });
  return outputs.flat();
});
const packageBuild = phase("packages", async () => {
  const ranges = Array.from({ length: Math.ceil(count / 1024) }, (_, i) => ({
    first: i * 1024,
    end: Math.min(count, (i + 1) * 1024),
  }));
  return (
    await pool(ranges, async ({ first, end }, i) => {
      const outputs: any[] = [];
      for (let next = first; next < end;) {
        const r = await call("/packages", `packages-${i}-${next}`, {
          catalogueRef,
          generation: packageGeneration,
          first: next,
          count: end - next,
          metadataSchema: config.metadataSchema,
        });
        if (r.first !== next || r.end <= next || r.end > end)
          throw Error("Package coverage mismatch");
        outputs.push(r);
        next = r.end;
      }
      return outputs;
    })
  ).flat();
});
const [postings, packages] = await Promise.all([finalBuild, packageBuild]);
const metadata = await phase("metadata", async () => {
  return pool(
    Array.from({ length: Math.ceil(count / 4096) }, (_, i) => i),
    async (i) =>
      call("/metadata", `metadata-${i}`, {
        first: i * 4096,
        count: Math.min(4096, count - i * 4096),
        schema: config.metadataSchema,
        parts: packages
          .filter((p) => p.first >= i * 4096 && p.first < (i + 1) * 4096)
          .map((p) => ({
            first: p.first,
            end: p.end,
            metadataRef: p.metadataRef,
          })),
      }),
  );
});
const pairs = await phase("pairs", () =>
  buildCompletePairs(catalogue, catalogueRef, packages, call, stage, pool),
);
const completed = await phase("publication", async () => {
  const objects: Root["objects"] = [],
    objectIds: number[] = [],
    hot: any[] = [],
    cold: any[] = [];
  for (const output of postings)
    output.objects.forEach((o: any, n: number) => {
      objects.push(o);
      objectIds.push(output.objectBase + n);
    });
  const allocated = objectIds
    .map((id, i) => ({ id, object: objects[i] }))
    .sort((a, b) => a.id - b.id);
  objects.length = objectIds.length = 0;
  for (const [i, item] of allocated.entries()) {
    if (i && allocated[i - 1].id === item.id)
      throw Error("Duplicate final object allocation");
    objectIds.push(item.id);
    objects.push(item.object);
  }
  for (const output of postings) {
    for (const block of output.hot)
      hot.push({
        first: block.first,
        count: block.count,
        data: await download(block.ref),
      });
    for (const c of output.cold)
      cold.push({ first: c.first, count: c.count, data: u32(c.ref) });
  }
  const directory = assembleTieredDirectory(
    assembleTermDirectory(hot),
    assembleTermDirectory(cold),
  );
  const groups = packages.map((p) => p.group),
    documents = encodeDocumentDirectory(
      groups.map((g) => ({
        ...g,
        offsets: Uint8Array.from(Buffer.from(g.offsets, "base64")),
        prefixes: Uint8Array.from(Buffer.from(g.prefixes, "base64")),
        verificationBytes: Uint8Array.from(
          Buffer.from(g.verificationBytes, "base64"),
        ),
      })),
      count,
    );
  const bytes = packages.reduce((n, p) => n + p.verificationBytes, 0),
    storedBytes = packages.reduce((n, p) => n + p.bytes, 0);
  const root: Root = {
    format: "CWS1",
    analysis: ENGLISH_ANALYSIS,
    generation: "",
    corpusHash: source,
    count,
    avgBody: bodyTokens / count,
    avgTitle: titleTokens / count,
    documents: [],
    dictionaries: [],
    hot: {},
    metadataFields: config.metadataSchema,
    metadataObjects: metadata.flatMap((m) => m.objects),
    objects,
    objectIds,
    directory: {
      sha256: createHash("sha256").update(directory).digest("hex"),
      bytes: directory.length,
      terms: catalogue.terms,
    },
    documentPackages: {
      generation: packageGeneration,
      count,
      averageBytes: bytes / count,
      bytes,
      storedBytes,
      locators: {
        sha256: createHash("sha256").update(documents).digest("hex"),
        bytes: documents.length,
        groups: groups.length,
      },
    },
  };
  root.pairMembership = {
    generation: pairs.metadata.generation,
    pairs: pairs.coverage.pairs,
    occurrences: pairs.coverage.occurrences,
    memberships: pairs.coverage.memberships,
    completeContext: true,
    objects: pairs.objects.map(({ key, size, sha256 }: any) => ({
      key,
      size,
      sha256,
    })),
  };
  root.generation = await generationFor(root);
  const metadataManifest = {
    format: "CWM1",
    generation: "",
    baseGeneration: root.generation,
    count,
    blockDocuments: 4096,
    schema: config.metadataSchema,
    blocks: metadata.map((m) => m.block),
  };
  const { generation: _emptyMetadataGeneration, ...metadataIdentity } =
    metadataManifest;
  metadataManifest.generation = hash(metadataIdentity);
  await mkdir(out + "/metadata", { recursive: true });
  await writeFile(
    out + "/metadata/metadata.json",
    JSON.stringify(metadataManifest),
  );
  const router = completePairRouter(pairs, root.generation);
  await mkdir(out + "/membership", { recursive: true });
  await writeFile(out + "/membership/router.bin", router);
  await writeFile(
    out + "/membership/presence.json",
    JSON.stringify(pairs.presence),
  );
  await writeFile(out + "/root.json", JSON.stringify(root));
  await writeFile(out + "/directory.bin", directory);
  await writeFile(out + "/documents.bin", documents);
  const directoryRef = await upload(directory),
    documentsRef = await upload(documents);
  const verifiedObjects = [
    ...objects,
    ...groups.map((g) => ({
      key: g.sha256 + "/plan-0.bin",
      size: unpackOffsets(g.offsets).at(-1)!,
      sha256: g.sha256,
    })),
    directoryRef,
    documentsRef,
    ...pairs.objects,
    ...metadata.flatMap((m) => m.objects),
  ];
  const verifications = await pool(
    Array.from(
      { length: Math.ceil(verifiedObjects.length / 256) },
      (_, i) => i,
    ),
    async (i) => {
      const task = `verify-${i}`;
      await call("/verify", task, {
        objects: verifiedObjects.slice(i * 256, (i + 1) * 256),
      });
      return { task };
    },
  );
  const manifestRef = await stage("final-manifest", {
    root,
    catalogueRef,
    pairCoverage: pairs.coverage,
    expectedPairOccurrences: packages
      .flatMap((p) => p.completePairs)
      .reduce((n, r) => n + r.occurrences, 0),
    metadataManifest,
    pairObjects: pairs.objects,
    presence: pairs.presence,
    terms: postings.reduce((n, p) => n + p.terms, 0),
    groups,
    objects: verifiedObjects,
    verifications,
    directoryRef,
    documentsRef,
  });
  const output = await call("/publish", "publish", { manifestRef });
  return { ...output, manifestRef, directoryRef, documentsRef };
});
function unpackOffsets(raw: string) {
  const bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  return importUnpack(bytes);
}
import { unpack as importUnpack } from "../src/columnar/format.js";
await atomic(out + "/completed.json", {
  ...completed,
  finishedAt: new Date().toISOString(),
  identity,
});
console.log(JSON.stringify({ completed, out }));
